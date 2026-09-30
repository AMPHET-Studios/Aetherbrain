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
import { parseMarkdown } from '../markdown/parse'
import { charOrigins, textTags, textWikilinks, wikilinkBrackets } from '../markdown/wikilink'
import { extractTasks } from '../markdown/tasks'
import { visit } from 'unist-util-visit'
import { basenameOf, folderOf, idFromPath, normalizePath, slugifyTitle } from '../vault/paths'
import { chatgptProjectUrl, cutBytes, wellFormed, type ChatArchive, type ChatConversation, type ChatMessage, type ChatProject, type ChatSource } from './exports'

/** Caps: one chat must never make a note the parser chokes on. */
export const MAX_MESSAGE_CHARS = 100_000
export const MAX_ATTACHMENT_CHARS = 20_000
export const MAX_ARTIFACT_CHARS = 100_000
export const MAX_DOC_CHARS = 200_000

export const TRANSCRIPT_HEADING = '## Transcript'
/** The last line of a transcript: what follows it (an AI's appended follow-up, the user's notes) is kept on update. */
export const TRANSCRIPT_END = '*— end of transcript —*'
export const SUMMARY_HEADING = '## Summary'
export const PROJECT_HEADING = '## Project'
/** The last line of a hub's `## Project` section: what follows it is the user's and stays on update. */
export const PROJECT_END = '*— end of project —*'

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
function linkTitle(text: string, maxBytes = 120): string {
  return cutBytes(
    wellFormed(text)
      .replace(/[[\]|#^\\/:*?"<>]+/g, ' ')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    maxBytes,
  ).replace(/^[. ]+|[. ]+$/g, '')
}

/**
 * A file or folder name every OS takes and the brain shows: no separators,
 * no leading dot (hidden, skipped: `.NET migration` → `NET migration`), no
 * trailing dot, not a reserved or skipped name, not too long.
 */
function safeName(text: string, maxBytes = 120): string {
  // Bytes, not characters: a file name is at most 255 bytes, and 60 CJK characters are 180 of them.
  const name = cutBytes(slugifyTitle(wellFormed(text).replace(/[\u0000-\u001f\u007f]+/g, ' ')), maxBytes)
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim()
  return /^(con|prn|aux|nul|com\d|lpt\d|node_modules|__macosx)$/i.test(name) ? `${name} chat` : name
}

/** A fence line: up to three spaces, then three or more backticks or tildes (CommonMark). */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** For each line: true inside a fenced code block that starts at the top level (fence lines included). */
function fenceMask(lines: string[]): boolean[] {
  const out: boolean[] = []
  let open: { ch: string; len: number } | null = null
  for (const line of lines) {
    const m = FENCE_LINE.exec(line)
    if (!open) {
      // A backtick fence's info string can't hold a backtick.
      if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
        open = { ch: m[1]![0]!, len: m[1]!.length }
        out.push(true)
      } else out.push(false)
    } else {
      out.push(true)
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && !m[2]!.trim()) open = null
    }
  }
  return out
}

/**
 * Close a fenced code block that `text` leaves open at its top level, so it
 * can't swallow what follows it in a note. Read from the parse, the way
 * CommonMark sees it: a fence opened inside a list item or a quote ends
 * with its container and needs nothing; one hidden in an HTML block is no
 * fence.
 */
export function closeFences(text: string): string {
  if (!/`{3,}|~{3,}/.test(text)) return text
  const tree = parseMarkdown(text)
  const last = tree.children[tree.children.length - 1]
  if (!last || last.type !== 'code') return text
  const start = last.position?.start.offset
  const end = last.position?.end.offset
  if (start === undefined || end === undefined) return text
  const lines = text.slice(start, end).split('\n')
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? '')
  if (!open) return text
  const fence = open[1]!
  const close = lines.length > 1 ? /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1] ?? '') : null
  if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) return text
  return `${text}\n${fence[0]!.repeat(fence.length)}`
}

/** A fence for `content`: longer than any backtick run inside it. */
function fenceFor(content: string): string {
  let longest = 0
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** An HTML block opener only its end marker closes (CommonMark types 1–5), at the start of a line. */
const HTML_OPENER_LINE = /^( {0,3})<(?=(?:script|pre|style|textarea)(?:[\s>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[)/i

/**
 * Most emphasis delimiters (`*`, `_`) one paragraph of chat text keeps.
 * micromark takes quadratic time on long runs of them (4,000 unmatched
 * delimiters: most of a second; 40,000: minutes), and a chat is text from
 * anywhere; past this, the paragraph's delimiters are escaped (shown as
 * written, not as emphasis).
 */
export const MAX_DELIMITERS = 1000

/** True when the character of `line` at `i` is escaped by an odd run of backslashes before it. */
function escapedAt(line: string, i: number): boolean {
  let n = 0
  for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) n++
  return n % 2 === 1
}

/**
 * Most square brackets one paragraph of chat text keeps: micromark's link
 * label matching also slows down sharply on thousands of them (16,000 in one
 * paragraph: seconds); past this, they are escaped (shown as written).
 */
export const MAX_BRACKETS = 1000

/**
 * Paragraphs of `text` holding more than MAX_DELIMITERS `*` and `_` (or more
 * than MAX_BRACKETS `[` and `]`), put in a code block: shown as written, and
 * parsed in linear time (escaping would not do: micromark is slow on
 * thousands of escapes too). Code is left alone. Real chats stay far below both.
 */
export function tameInline(text: string): string {
  let delims = 0
  let brackets = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 42 || c === 95) delims++
    else if (c === 91 || c === 93) brackets++
  }
  if (delims <= MAX_DELIMITERS && brackets <= MAX_BRACKETS) return text
  const lines = text.split('\n')
  const code = fenceMask(lines)
  let start = 0
  const paragraph = (end: number) => {
    let d = 0
    let b = 0
    for (let i = start; i < end; i++) {
      for (const ch of lines[i]!) {
        if (ch === '*' || ch === '_') d++
        else if (ch === '[' || ch === ']') b++
      }
    }
    if (d <= MAX_DELIMITERS && b <= MAX_BRACKETS) return
    // Shown as written, in a code block: code is never parsed inline (linear), and holds no link or tag.
    const block = lines.slice(start, end).join('\n')
    let longest = 0
    for (const m of block.matchAll(/~+/g)) longest = Math.max(longest, m[0].length)
    const fence = '~'.repeat(Math.max(3, longest + 1))
    lines[start] = `${fence}text\n${lines[start]}`
    lines[end - 1] = `${lines[end - 1]}\n${fence}`
  }
  for (let i = 0; i < lines.length; i++) {
    if (code[i] || !lines[i]!.trim()) {
      paragraph(i)
      start = i + 1
    }
  }
  paragraph(lines.length)
  return lines.join('\n')
}

/**
 * Markdown written live into a note (a summary): an open fence closed, block
 * HTML openers that would swallow the rest of the note escaped, and
 * paragraphs with pathological runs of emphasis delimiters escaped.
 */
export function tameChatMarkdown(text: string): string {
  const lines = closeFences(text).split('\n')
  const code = fenceMask(lines)
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue
    const m = HTML_OPENER_LINE.exec(lines[i]!)
    if (m) lines[i] = `${m[1]}\\${lines[i]!.slice(m[1]!.length)}`
  }
  return tameInline(lines.join('\n'))
}

/** Headings of level 1 and 2 pushed down to 3 and 4 (outside code), so a summary can't start a section of the note. */
function demoteHeadings(text: string): string {
  const lines = text.split('\n')
  const code = fenceMask(lines)
  return lines.map((l, i) => (!code[i] && /^ {0,3}#{1,2}(\s|$)/.test(l) ? l.replace(/^( {0,3})/, '$1##') : l)).join('\n')
}

/**
 * Every line of `text` behind `> ` (an empty line: `>`). A message quoted
 * this way is kept whole whatever it holds: a fence it leaves open, an HTML
 * block, a list all end with the quote (CommonMark closes what a container
 * holds when it ends), and the brain's line-by-line task scan never reads a
 * quoted line as a task.
 */
export function quoteMarkdown(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.length ? `> ${l}` : '>'))
    .join('\n')
}

/** Offsets (in `body`) of everything from `from` on that the brain would read as a wikilink, an inline tag or a task. */
function liveMarks(body: string, from: number): number[] {
  const tree = parseMarkdown(body)
  const at = new Set<number>()
  visit(tree, (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined || end <= from) return
    if (node.type === 'text') {
      const value = (node as { value: string }).value
      const src = body.slice(start, end)
      // Both brackets of each side: an escape keeps them balanced, so a link around them stays a link.
      const links = textWikilinks(value, src)
      if (links.length) {
        const brackets = wikilinkBrackets(value, src, links)
        if (brackets) for (const b of brackets.flat()) at.add(start + b)
        else for (let i = 0; i < src.length; i++) if (src[i] === '[' || src[i] === ']') at.add(start + i)
      }
      const tags = textTags(value, src)
      if (tags.length) {
        const origins = charOrigins(value, src, '#')
        const ordinal = new Map<number, number>()
        for (let i = 0, k = 0; i < value.length; i++) if (value[i] === '#') ordinal.set(i, k++)
        for (const t of tags) {
          const o = origins?.[ordinal.get(t.index) ?? -1]
          if (o && !o.escaped) at.add(start + o.at)
          else if (!origins) for (let i = 0; i < src.length; i++) if (src[i] === '#') at.add(start + i)
        }
      }
    } else if (node.type === 'listItem' && typeof (node as { checked?: unknown }).checked === 'boolean') {
      // A GFM task list item: its checkbox would show as a to-do in the preview.
      const m = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[/.exec(body.slice(start, start + 24))
      if (m) at.add(start + m[0].length - 1)
    }
  })
  // Tasks are read line by line (tasks.ts), not from the tree: escape what that scan sees too.
  const lines = body.split('\n')
  let off = 0
  const lineStart: number[] = []
  for (const l of lines) {
    lineStart.push(off)
    off += l.length + 1
  }
  for (const t of extractTasks(body)) {
    const o = lineStart[t.line]
    if (o === undefined || o < from) continue
    const m = /^\s*[-*+]\s+\[/.exec(lines[t.line]!)
    if (m) at.add(o + m[0].length - 1)
  }
  return [...at].filter((i) => i >= from)
}

/**
 * Make chat text inert from offset `from` on: escape everything the brain
 * would read as a wikilink (`\[\[x\]\]`), an inline tag (`\#word`) or a task
 * (`- \[ ]`), parsing the way the brain parses notes. Code is untouched.
 * The result is parsed again; should anything still be live (an escape that
 * changed how the rest parses), it fails closed (`blanketInert`). Messages
 * should be quoted (`quoteMarkdown`) so nothing in them can reach past them.
 */
export function inertMarkdown(body: string, from = 0): string {
  const marks = liveMarks(body, from)
  if (!marks.length) return body
  const out = insertBackslashes(body, marks)
  return liveMarks(out, from).length ? blanketInert(out, from) : out
}

/**
 * The fail-closed escape: from `from` on, every bracket, every `#` before a
 * word character and every task checkbox is escaped, in code too (a stray
 * backslash there is the price of never leaking a link, tag or task).
 */
export function blanketInert(body: string, from = 0): string {
  const rest = body
    .slice(from)
    .split('\n')
    .map((line) => {
      let out = ''
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!
        const escape = (ch === '[' || ch === ']' || (ch === '#' && /[\p{L}\p{N}_]/u.test(line[i + 1] ?? ''))) && !escapedAt(line, i)
        out += escape ? `\\${ch}` : ch
      }
      return out
    })
    .join('\n')
  return body.slice(0, from) + rest
}

/** `text` with a backslash put before each offset (one pass). */
function insertBackslashes(text: string, offsets: number[]): string {
  const sorted = [...new Set(offsets)].sort((a, b) => a - b)
  const parts: string[] = []
  let last = 0
  for (const i of sorted) {
    parts.push(text.slice(last, i), '\\')
    last = i
  }
  parts.push(text.slice(last))
  return parts.join('')
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

/**
 * The web address of a chat as a `Source:` line carries it (the note's
 * identity on re-import), or null: `https://claude.ai/chat/<id>` or
 * `https://chatgpt.com/c/<id>`. ChatGPT's other spellings of the same chat
 * (`chat.openai.com`, `www.`, `/g/g-p-…/c/<id>` inside a project or GPT)
 * become that one; a trailing slash, query or fragment is dropped.
 */
export function chatUrlOf(url: string): string | null {
  const m = /^https:\/\/(?:www\.)?(claude\.ai\/chat|(?:chatgpt\.com|chat\.openai\.com)(?:\/g\/g-[A-Za-z0-9-]{1,120})?\/c)\/([A-Za-z0-9_-]{6,80})\/?(?:[?#]\S*)?$/.exec(url.trim())
  if (!m) return null
  return m[1] === 'claude.ai/chat' ? `https://claude.ai/chat/${m[2]}` : `https://chatgpt.com/c/${m[2]}`
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
  const out: string[] = []
  if (m.text) out.push(tameInline(cleanText(m.text, MAX_MESSAGE_CHARS)), '')
  for (const img of m.images) {
    const file = opts.pictures?.get(img.fileId)
    out.push(file ? live.add(`![[${file}]]`) : '🖼 *picture not imported*', '')
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
  // The message whole behind `> `: nothing in it reaches past it.
  return `### ${speaker}${stamp}\n\n${quoteMarkdown(out.join('\n').trimEnd())}\n`
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
  return `${live.fill(body).replace(/\n{3,}/g, '\n\n').trimEnd()}\n\n${TRANSCRIPT_END}\n`
}

/**
 * A summary for the top of a chat note (`## Summary` and its text). Live
 * markdown — its links, tags and tasks count — but tamed like chat text,
 * and its own headings pushed below level 2 so it can't start a section.
 */
export function renderSummary(text: string): string {
  return `${SUMMARY_HEADING}\n\n${demoteHeadings(tameChatMarkdown(cleanText(text.trim(), MAX_MESSAGE_CHARS)))}\n\n`
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
  const summary = opts.summary?.trim() ? renderSummary(opts.summary) : ''
  const body = `# ${inlineText(title, 200)}\n\n${chatHeader(conv, opts)}\n\n${summary}${renderTranscript(conv, opts)}`
  return joinFrontmatter(fm, body)
}

// ------------------------------------------------------------------ projects

/** `PORTALz (Claude project)`: the title (and file name) of a project's hub note. */
export function projectHubTitle(project: ChatProject): string {
  return `${linkTitle(project.name, 100) || 'Project'} (${SOURCE_NAME[project.source]} project)`
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
  if (project.description) out.push(quoteMarkdown(tameInline(cleanText(project.description, MAX_DOC_CHARS))), '')
  if (project.instructions) out.push('### Instructions', '', quoteMarkdown(tameInline(cleanText(project.instructions, MAX_DOC_CHARS))), '')
  if (opts.docs?.length) out.push('### Knowledge', '', ...opts.docs.map((t) => live.add(`- [[${t}]]`)), '')
  if (opts.chats?.length) out.push('### Chats', '', ...opts.chats.map((t) => live.add(`- [[${t}]]`)), '')
  const text = inertMarkdown(out.join('\n'), PROJECT_HEADING.length)
  return `${live.fill(text).replace(/\n{3,}/g, '\n\n').trimEnd()}\n\n${PROJECT_END}\n`
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

/** The `Source:` of a knowledge doc: its project's address and its file name (the doc's identity on re-import). */
export function projectDocUrl(project: ChatProject, name: string): string {
  return `${project.url}#${encodeURIComponent(wellFormed(name))}`
}

export function renderProjectDoc(project: ChatProject, doc: { name: string; content: string }, title: string, hubTitle: string, utc = false): string {
  const created = dayOf(project.created, utc)
  const fm: Record<string, unknown> = { title, tags: ['ai-knowledge', project.source] }
  if (created) fm.created = created
  const content = cleanText(doc.content, MAX_DOC_CHARS)
  const lang = docLanguage(doc.name)
  const live = new Live()
  const head = `# ${inlineText(title, 200)}\n\nKnowledge of ${live.add(`[[${hubTitle}]]`)} · ${inlineText(doc.name, 200)}  \nSource: <${projectDocUrl(project, doc.name)}>\n\n## Document\n\n`
  const fence = lang === null ? '' : fenceFor(content)
  const text = lang === null ? tameInline(content) : `${fence}${lang}\n${content}\n${fence}`
  const body = inertMarkdown(head + quoteMarkdown(text), head.length)
  return joinFrontmatter(fm, `${live.fill(body).trimEnd()}\n`)
}

// ------------------------------------------------------------------ re-import

/** Lines of a note's header: after the frontmatter, before its first `## ` heading (where the importer writes `Source:`). */
function headerLines(raw: string): string[] {
  const { bodyOffset } = splitFrontmatter(raw)
  const out: string[] = []
  for (const line of raw.slice(bodyOffset).split('\n')) {
    const l = line.replace(/\r$/, '')
    if (/^##\s/.test(l)) break
    out.push(l)
  }
  return out
}

/** True for a note the importer (or save_chat) wrote as a chat. */
export function isChatNote(note: ParsedNote): boolean {
  return note.meta.tags.includes('ai-chat')
}

/** True for a project hub the importer wrote. */
export function isProjectHub(note: ParsedNote): boolean {
  return note.meta.tags.includes('ai-project')
}

/**
 * Notes the importer wrote, by the `Source: <url>` line in their header
 * (above the first `## ` heading: a line quoted in a transcript or summary
 * never counts): url → note. A note tagged `ai-chat` / `ai-project` wins
 * over another note carrying the same line.
 */
export function importedNotes(notes: Iterable<ParsedNote>): Map<string, ParsedNote> {
  const out = new Map<string, ParsedNote>()
  for (const n of notes) {
    if (!n.raw.includes('Source: <https://')) continue
    const own = isChatNote(n) || isProjectHub(n)
    for (const line of headerLines(n.raw)) {
      const m = /^Source: <(https:\/\/[^>\s]+)>\s*$/.exec(line)
      if (!m) continue
      const url = m[1]!
      const had = out.get(url)
      if (!had || (own && !(isChatNote(had) || isProjectHub(had)))) out.set(url, n)
    }
  }
  return out
}

/** Folders of ChatGPT projects already imported: project url → folder of one of its chats (header lines only). */
function chatgptProjectFolders(notes: Iterable<ParsedNote>): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of notes) {
    if (!n.raw.includes('ChatGPT project: <') || !isChatNote(n)) continue
    for (const line of headerLines(n.raw)) {
      const m = /^ChatGPT project: <(https:\/\/[^>\s]+)>/.exec(line)
      if (m && !out.has(m[1]!)) out.set(m[1]!, n.meta.folder)
    }
  }
  return out
}

/** Where a section of `raw` is: the line `heading` (the first, after the frontmatter) to the last line `end` after it (or the end). */
function sectionSpan(raw: string, heading: string, end?: string): { from: number; to: number } | null {
  const { bodyOffset } = splitFrontmatter(raw)
  let at = bodyOffset
  let from = -1
  for (;;) {
    const stop = raw.indexOf('\n', at)
    const line = raw.slice(at, stop < 0 ? raw.length : stop).replace(/\r$/, '')
    if (line.trimEnd() === heading) {
      from = at
      break
    }
    if (stop < 0) return null
    at = stop + 1
  }
  let to = raw.length
  if (end) {
    let last = -1
    for (let i = raw.indexOf('\n', from); i >= 0 && i < raw.length; i = raw.indexOf('\n', i + 1)) {
      const next = raw.indexOf('\n', i + 1)
      const line = raw.slice(i + 1, next < 0 ? raw.length : next).replace(/\r$/, '')
      if (line.trimEnd() === end) last = next < 0 ? raw.length : next + 1
    }
    if (last >= 0) to = last
  }
  return { from, to }
}

/**
 * `raw` with its section `heading` … `end` (the last `end` line after the
 * heading, inclusive; no `end`: to the end of the note) replaced by
 * `section`, or null when the note has no such heading outside its
 * frontmatter. What follows the end line stays. Line endings follow the note's.
 */
export function replaceSection(raw: string, heading: string, section: string, end?: string): string | null {
  const span = sectionSpan(raw, heading, end)
  if (!span) return null
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const text = eol === '\n' ? section : section.replace(/\n/g, '\r\n')
  const after = raw.slice(span.to)
  return raw.slice(0, span.from) + text + (after && !text.endsWith(eol) ? eol : '') + after
}

/** The section of `raw` from the line `heading` to the last `end` line (or the end), or null. */
export function sectionOf(raw: string, heading: string, end?: string): string | null {
  const span = sectionSpan(raw, heading, end)
  return span ? raw.slice(span.from, span.to).replace(/\r\n/g, '\n') : null
}

/**
 * `raw` with its summary set to `text`: the `## Summary` section (up to the
 * transcript) replaced, or a new one put before `## Transcript`. Null when
 * the note has neither heading.
 */
export function replaceSummary(raw: string, text: string): string | null {
  const summary = renderSummary(text)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const s = sectionSpan(raw, SUMMARY_HEADING)
  const t = sectionSpan(raw, TRANSCRIPT_HEADING)
  if (!t) return null
  const block = eol === '\n' ? summary : summary.replace(/\n/g, '\r\n')
  if (s && s.from < t.from) return raw.slice(0, s.from) + block + raw.slice(t.from)
  return raw.slice(0, t.from) + block + raw.slice(t.from)
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
    for (const a of n.meta.aliases) titles.add(a.trim().toLowerCase())
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

  // Projects first: their hubs decide where their chats go. A note is only taken for a hub or a chat
  // when the importer wrote it (tagged); a note of the user's carrying an address is left alone.
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
    const found = imported.get(p.url)
    const hub = found && isProjectHub(found) ? found : null
    const match = byName.get(norm(p.name)) ?? null
    let dir: string
    let hubTitle = ''
    if (hub) {
      dir = hub.meta.folder
      hubTitle = hub.meta.title
    } else dir = match ? join(match.home, 'AI Chats') : join(opts.base, SOURCE_NAME[p.source], safeName(p.name, 90) || `Project ${safeName(p.id, 24)}`)
    places.set(p.id, { dir, hubTitle, hubPath: null, aether: match?.title ?? null, hub, project: p, docs: [], chats: [] })
  }
  // Hub titles for new hubs (after existing ones took theirs).
  for (const place of places.values()) {
    if (place.hub) continue
    const [path, title] = freeNote(place.dir, projectHubTitle(place.project))
    place.hubTitle = title
    place.hubPath = path
  }

  // Knowledge docs: known by their Source (project + file name), created once, next to the hub.
  for (const place of places.values()) {
    const kdir = join(place.dir, 'Knowledge')
    for (const doc of place.project.docs) {
      const found = imported.get(projectDocUrl(place.project, doc.name))
      if (found) {
        if (!place.docs.includes(found.meta.title)) place.docs.push(found.meta.title)
        continue
      }
      const name = `${linkTitle(place.project.name, 60) || 'Project'} – ${safeName(doc.name.replace(/\.[a-z0-9]+$/i, ''), 90) || 'Document'}`
      const [path, title] = freeNote(kdir, name)
      place.docs.push(title)
      const { project, hubTitle } = place
      plan.create.push(lazyNote({ path, kind: 'doc', source: project.source }, () => renderProjectDoc(project, doc, title, hubTitle, utc)))
      plan.counts.docs++
      folders.add(kdir)
    }
  }

  // Chats.
  const pictureNames = new Set([...pictureTaken].map((p) => p.slice(p.lastIndexOf('/') + 1)))
  const sorted = [...archive.conversations].sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || a.id.localeCompare(b.id))
  for (const conv of sorted) {
    if (!conv.messages.length) continue
    plan.counts[conv.source]++
    plan.counts.messages += conv.messages.length
    const place = conv.projectId ? places.get(conv.projectId) : undefined
    const found = imported.get(conv.url)
    const existingNote = found && isChatNote(found) ? found : null
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
        const short = conv.projectId.replace(/^g-p-/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unnamed'
        dir = gptFolders.get(chatgptProjectUrl(conv.projectId)) ?? join(opts.base, 'ChatGPT', `Project ${short}`)
      } else dir = join(opts.base, SOURCE_NAME[conv.source])
      ;[path, title] = freeNote(dir, chatBaseName(conv, utc))
    }
    // Pictures: `<chat folder>/Pictures/<chat> <n>.<ext>`, created once: one of that name anywhere
    // in the vault (the note or its pictures were moved) is taken as already there.
    const pictures = new Map<string, string>()
    let added = 0
    let n = 0
    for (const m of conv.messages) {
      for (const img of m.images) {
        const from = pics.get(img.fileId)
        if (!from || pictures.has(img.fileId)) continue
        n++
        const ext = (/\.[a-z0-9]+$/i.exec(from)?.[0] ?? '.png').toLowerCase()
        const file = `${safeName(title, 140)} ${n}${ext}`
        const target = join(dir, 'Pictures', file)
        pictures.set(img.fileId, file)
        if (pictureTaken.has(target.toLowerCase()) || pictureNames.has(file.toLowerCase())) continue
        pictureTaken.add(target.toLowerCase())
        pictureNames.add(file.toLowerCase())
        added++
        plan.pictures.push({ from, path: target })
        plan.counts.pictures++
        folders.add(folderOf(target))
      }
    }
    const renderOpts: ChatRenderOptions = { utc, pictures, projectLink: place?.hubTitle ?? null, aetherProject: place?.aether ?? null }
    if (place) place.chats.push({ title, created: conv.created ?? '' })
    // (An address found on a note that is not the importer's — a user's own note — gets the chat a note of its own.)
    if (existingNote) {
      const current = sectionOf(existingNote.raw, TRANSCRIPT_HEADING, TRANSCRIPT_END)
      const count = current === null ? null : transcriptCount(current)
      // A transcript is rewritten only when the chat grew or brought new pictures: edits the user made stay.
      if (current === null || (count === conv.messages.length && added === 0)) {
        plan.unchanged++
        continue
      }
      plan.update.push(
        lazyUpdate(
          { noteId: existingNote.meta.id, path: existingNote.meta.path, heading: TRANSCRIPT_HEADING, updated: dayOf(conv.updated, utc), kind: 'chat' },
          () => renderTranscript(conv, renderOpts),
        ),
      )
      continue
    }
    plan.create.push(lazyNote({ path, kind: 'chat', source: conv.source }, () => renderChatNote(conv, title, renderOpts)))
    folders.add(dir)
  }

  // Hubs last: they list their docs and chats. An export with no chats at all (projects.json
  // alone) says nothing about which chats a project has: a hub's list then stays as it is.
  for (const place of places.values()) {
    plan.counts.projects++
    const current = place.hub ? sectionOf(place.hub.raw, PROJECT_HEADING, PROJECT_END) : null
    const chats = archive.conversations.length
      ? place.chats.sort((a, b) => b.created.localeCompare(a.created)).map((c) => c.title)
      : current
        ? listedChats(current)
        : []
    const ropts: ProjectRenderOptions = { utc, docs: place.docs, chats, aetherProject: place.aether }
    if (place.hub) {
      const section = renderProjectSection(place.project, ropts)
      if (current === null || current === section) continue
      plan.update.push(
        lazyUpdate({ noteId: place.hub.meta.id, path: place.hub.meta.path, heading: PROJECT_HEADING, updated: dayOf(place.project.updated, utc), kind: 'project' }, () => section),
      )
      continue
    }
    if (!place.hubPath) continue
    const { project, hubTitle } = place
    plan.create.push(lazyNote({ path: place.hubPath, kind: 'project', source: project.source }, () => renderProjectHub(project, hubTitle, ropts)))
    folders.add(place.dir)
  }

  plan.folders = [...folders].filter(Boolean).sort()
  return plan
}

/** The chat titles a hub's `### Chats` list links, in order. */
function listedChats(section: string): string[] {
  const at = section.indexOf('\n### Chats\n')
  if (at < 0) return []
  const out: string[] = []
  for (const line of section.slice(at + 11).split('\n')) {
    if (line.startsWith('#') || line.startsWith('*— end')) break
    const m = /^- \[\[([^[\]]+)\]\]\s*$/.exec(line)
    if (m) out.push(m[1]!)
  }
  return out
}

/**
 * A planned note whose text is made when first read: rendering (a parse per
 * chat) is the costly part of an import, so the store renders each note as
 * it writes it, a chunk at a time, instead of all of them up front.
 */
function lazyNote(n: Omit<PlannedNote, 'content'>, render: () => string): PlannedNote {
  let text: string | null = null
  return Object.defineProperty(n, 'content', { get: () => (text ??= render()), enumerable: true }) as PlannedNote
}

function lazyUpdate(u: Omit<PlannedUpdate, 'section'>, render: () => string): PlannedUpdate {
  let text: string | null = null
  return Object.defineProperty(u, 'section', { get: () => (text ??= render()), enumerable: true }) as PlannedUpdate
}

/** Apply a planned update to the note's text on disk: the section replaced, `updated` patched. Null when the section is gone. */
export function applyChatUpdate(raw: string, u: Pick<PlannedUpdate, 'heading' | 'section' | 'updated'>): string | null {
  const next = replaceSection(raw, u.heading, u.section, u.heading === TRANSCRIPT_HEADING ? TRANSCRIPT_END : u.heading === PROJECT_HEADING ? PROJECT_END : undefined)
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
