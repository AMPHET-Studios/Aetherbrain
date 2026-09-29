/**
 * Projects as editable stars.
 *
 * A project is a plain markdown note (`type: project`, or a note sitting in
 * the Projects area folder). Its *home folder* holds the project's files; in
 * the system layout that folder is the star and its subfolders are planets.
 * Everything here reads and rewrites ordinary markdown — no sidecar files.
 */
import type { Frontmatter, ParsedNote } from '../types'
import { asString, asStringArray, joinFrontmatter, splitFrontmatter } from './frontmatter'
import { normalizeTag } from './parse'
import { projectNote } from './tasks'
import { areaFromFolder, areaOfFolderName, basenameOf, folderOf, normalizeFolderPath } from '../vault/paths'

/** ATX H1; a closing `#` run only counts after whitespace (`# Learn C#` keeps its `#`). */
const H1_RE = /^#\s+(.*?)(?:\s+#+)?\s*$/
const FENCE_RE = /^\s*(```|~~~)/
const QUOTE_RE = /^\s{0,3}>/

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** True for `Projects` or `<mount>/Projects` (any PARA spelling of Projects, e.g. `1 Projects`). */
function isProjectsAreaFolder(folder: string): boolean {
  if (!folder) return false
  const segs = folder.split('/')
  if (segs.length === 1) return areaOfFolderName(segs[0] ?? '') === 'projects'
  return segs.length === 2 && areaOfFolderName(segs[0] ?? '') === null && areaOfFolderName(segs[1] ?? '') === 'projects'
}

/**
 * True for an explicit `type: project` in frontmatter, or a note sitting
 * directly in the Projects area folder (`Projects/X.md`, `D/Projects/X.md`), or
 * the folder note of a direct child of it (`Projects/X/X.md`). Never for notes
 * in Archive. Notes deeper inside a project folder are ordinary notes of that
 * project, even though their folder-derived `meta.type` says 'project'.
 * The Projects folder's own folder note (`Projects/Projects.md`, an index of
 * projects) is not a project unless it says `type: project`: otherwise the
 * whole area would become one star with every project as its planet.
 */
export function isProjectNote(note: ParsedNote): boolean {
  const { path, folder, area } = note.meta
  if (area === 'archive' || areaFromFolder(path) === 'archive') return false
  if (asString(note.frontmatter['type'])?.toLowerCase() === 'project') return true
  const base = basenameOf(path).toLowerCase()
  if (isProjectsAreaFolder(folder)) return lastSegment(folder).toLowerCase() !== base
  return isProjectsAreaFolder(folderOf(folder)) && lastSegment(folder).toLowerCase() === base
}

/**
 * Home folder of a project:
 *  1. frontmatter `folder:` (vault path, normalized; returned even when it
 *     does not exist yet, so the UI can offer to create it);
 *  2. the note is a folder note — its basename equals its folder's basename
 *     (case-insensitive): that folder;
 *  3. a sibling folder named like the note (`Projects/PORTALz.md` +
 *     `Projects/PORTALz/`) when it exists in `folders`;
 * else null.
 */
export function projectFolderOf(note: ParsedNote, folders: Set<string>): string | null {
  const explicit = asString(note.frontmatter['folder'])
  if (explicit) {
    const f = normalizeFolderPath(explicit)
    if (f) return f
  }
  const base = basenameOf(note.meta.path)
  const folder = note.meta.folder
  if (folder && lastSegment(folder).toLowerCase() === base.toLowerCase()) return folder
  const sibling = folder ? `${folder}/${base}` : base
  return folders.has(sibling) ? sibling : null
}

/** Where a new folder for a project without one goes: `<note folder>/<basename>`. */
export function defaultProjectFolder(note: ParsedNote): string {
  const base = basenameOf(note.meta.path)
  return note.meta.folder ? `${note.meta.folder}/${base}` : base
}

export interface ProjectPatch {
  title?: string
  status?: string | null
  summary?: string | null
  tags?: string[]
  folder?: string | null
}

/** A line without its ending (`\r\n` or `\n`). */
function textOf(line: string): string {
  return line.replace(/\r?\n$/, '')
}

/** The ending a line carries: `\r\n`, `\n`, or '' for a last line without one. */
function eolOf(line: string | undefined): string {
  return line?.endsWith('\r\n') ? '\r\n' : line?.endsWith('\n') ? '\n' : ''
}

/** Split text into lines that keep their own endings, so untouched lines rejoin byte-identical. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Index of the first ATX H1 outside fenced code, or -1. */
function findH1(lines: string[]): number {
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const l = textOf(lines[i] ?? '')
    if (FENCE_RE.test(l)) inFence = !inFence
    else if (!inFence && H1_RE.test(l)) return i
  }
  return -1
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === ''
}

/** The summary blockquote: the lines of a `>` block that is the first thing after the H1 (or the body start). */
function summaryBlock(lines: string[], h1: number): { start: number; end: number } {
  let start = h1 + 1
  while (isBlank(lines[start])) start++
  let end = start
  while (end < lines.length && QUOTE_RE.test(lines[end] ?? '')) end++
  return { start, end }
}

/**
 * Insert text lines at `at`, each ending in `eol`. Appended at the very end
 * they follow the file's own habit: a last line without an ending gets one,
 * the new last line then goes without, and no trailing blank line is added.
 */
function insertLines(lines: string[], at: number, add: string[], eol: string): void {
  if (at < lines.length) {
    lines.splice(at, 0, ...add.map((l) => l + eol))
    return
  }
  const rows = [...add]
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  const last = lines[lines.length - 1]
  const open = last !== undefined && eolOf(last) === ''
  if (open) lines[lines.length - 1] = last + eol
  lines.push(...rows.map((l, i) => (open && i === rows.length - 1 ? l : l + eol)))
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A frontmatter block with content that did not parse into keys (invalid
 * YAML, or not a mapping). Rewriting it would silently throw that text away.
 */
function unparsedFrontmatter(raw: string, split: ReturnType<typeof splitFrontmatter>): boolean {
  if (!split.hasFrontmatter || Object.keys(split.frontmatter).length > 0) return false
  const block = raw.slice(0, split.bodyOffset).split(/\r?\n/).slice(1)
  return block.some((l) => !/^\s*(#.*|---|\.\.\.)?\s*$/.test(l))
}

/** Aliases as written: a list, or one string of comma-separated aliases (`aliases: Portal game`). */
function aliasList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(',').map((a) => a.trim()).filter(Boolean)
  return asStringArray(v)
}

/**
 * Rewrite a project note.
 *  - title: frontmatter `title` + the first H1; the old title is appended to
 *    `aliases` (deduplicated, case-insensitively like link resolution) so
 *    existing [[links]] keep resolving; an alias equal to the new title goes.
 *  - summary: replaces the `>` blockquote right after the H1, inserts one
 *    after the H1 when missing, removes it for '' / null.
 *  - status / tags / folder: frontmatter keys; null (or '') deletes the key.
 * The rest of the body stays byte-identical (every line keeps its own
 * ending), and the frontmatter block is not re-serialized unless one of its
 * keys changes; a rewritten block keeps the file's CRLF / LF. Throws instead
 * of rewriting a frontmatter block whose YAML does not parse.
 */
export function setProjectFields(raw: string, patch: ProjectPatch): string {
  const split = splitFrontmatter(raw)
  const fm: Frontmatter = { ...split.frontmatter }
  // A byte-order mark stays the first thing in the file, whatever is rewritten.
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const original = split.hasFrontmatter ? split.body : split.body.slice(bom.length)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = linesOf(original)
  const h1 = findH1(lines)
  let fmChanged = false
  let bodyChanged = false

  const setKey = (key: string, value: unknown): void => {
    if (value === null) {
      if (key in fm) {
        delete fm[key]
        fmChanged = true
      }
    } else if (!sameValue(fm[key], value)) {
      fm[key] = value
      fmChanged = true
    }
  }

  const title = patch.title?.replace(/\s+/g, ' ').trim()
  const h1Raw = h1 >= 0 ? (H1_RE.exec(textOf(lines[h1] ?? ''))?.[1] ?? null) : null
  // The H1 as the note's title reads (`# **PORTALz**` → PORTALz), like parseNote.
  const h1Text = h1Raw === null ? null : plainInline(h1Raw)
  const old = asString(fm['title']) ?? h1Text
  // Only a real change touches anything: saving the current title is a no-op.
  if (title && title !== old) {
    setKey('title', title)
    if (h1Text !== null && h1Text !== title) {
      lines[h1] = `# ${title}${eolOf(lines[h1])}`
      bodyChanged = true
    }
    if (old) {
      // Case-insensitive like link resolution: the title itself already resolves.
      const seen = new Set([title.toLowerCase()])
      const aliases: string[] = []
      for (const a of [...aliasList(fm['aliases']), old]) {
        const k = a.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        aliases.push(a)
      }
      if (aliases.length || 'aliases' in fm) setKey('aliases', aliases.length ? aliases : null)
    }
  }

  if (patch.summary !== undefined) {
    const text = (patch.summary ?? '').replace(/\s+/g, ' ').trim()
    const { start, end } = summaryBlock(lines, h1)
    if (end > start) {
      if (text) lines.splice(start, end - start, `> ${text}${eolOf(lines[end - 1])}`)
      else {
        lines.splice(start, end - start)
        // Don't leave two blank lines, or a trailing blank line, where the quote was.
        if (isBlank(lines[start]) && (start === 0 || isBlank(lines[start - 1]))) lines.splice(start, 1)
        else if (start === lines.length && isBlank(lines[start - 1])) lines.splice(start - 1, 1)
      }
      bodyChanged = true
    } else if (text) {
      const quote = `> ${text}`
      if (h1 < 0) insertLines(lines, start, [quote, ''], eol)
      else if (isBlank(lines[h1 + 1])) insertLines(lines, h1 + 2, [quote, ''], eol)
      else insertLines(lines, h1 + 1, ['', quote, ''], eol)
      bodyChanged = true
    }
  }

  if (patch.status !== undefined) setKey('status', patch.status?.trim() || null)
  if (patch.tags !== undefined) setKey('tags', [...new Set(patch.tags.map(normalizeTag).filter(Boolean))])
  if (patch.folder !== undefined) setKey('folder', patch.folder === null ? null : normalizeFolderPath(patch.folder) || null)

  const body = bodyChanged ? lines.join('') : original
  if (!fmChanged) return split.hasFrontmatter ? raw.slice(0, split.bodyOffset) + body : bom + body
  if (unparsedFrontmatter(raw, split)) throw new Error('The frontmatter is not valid YAML; fix it before editing the project')
  if (Object.keys(fm).length === 0) return bom + body
  // `joinFrontmatter(fm, '')` ends with `---\n\n`; keep the original gap before the body.
  const block = joinFrontmatter(fm, '')
  const head = split.hasFrontmatter ? block.slice(0, -1) : block
  const fmEol = split.hasFrontmatter ? (raw.slice(0, split.bodyOffset).includes('\r\n') ? '\r\n' : '\n') : eol
  return bom + (fmEol === '\n' ? head : head.replace(/\n/g, fmEol)) + body
}

/** Markdown inline syntax → readable text for cards (wikilinks, links, emphasis, code). */
function plainInline(text: string): string {
  return text
    .replace(/!?\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
      const pipe = inner.indexOf('|')
      if (pipe >= 0) return inner.slice(pipe + 1).trim()
      const hash = inner.indexOf('#')
      return (hash >= 0 ? inner.slice(0, hash) : inner).trim()
    })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|[^\p{L}\p{N}])[*_]([^*_]+)[*_](?=$|[^\p{L}\p{N}])/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Project summary as shown on cards: the blockquote right after the H1, else the first paragraph. */
export function projectSummary(note: ParsedNote): string {
  const lines = note.body.split(/\r?\n/)
  const h1 = findH1(lines)
  const { start, end } = summaryBlock(lines, h1)
  if (end > start) return plainInline(lines.slice(start, end).map((l) => l.replace(QUOTE_RE, '')).join(' '))
  let inFence = false
  const para: string[] = []
  for (let i = h1 + 1; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (FENCE_RE.test(l)) {
      if (para.length) break
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const structural = l.trim() === '' || /^#{1,6}\s/.test(l) || /^\s*([-*+]|\d+[.)])\s/.test(l) || /^\s*\|/.test(l)
    if (structural) {
      if (para.length) break
      continue
    }
    para.push(l)
  }
  return plainInline(para.join(' '))
}

/**
 * A folder note that makes an existing folder a project: `<folder>/<basename>.md`.
 * Being a folder note, it binds to the folder without a `folder:` key.
 */
export function folderProjectNote(
  folder: string,
  opts: { summary?: string; tags?: string[] } = {},
  now = new Date(),
): { path: string; content: string; title: string } {
  const dir = normalizeFolderPath(folder)
  if (!dir) throw new Error('The vault root cannot be a project folder')
  const name = lastSegment(dir)
  const note = projectNote({ name, summary: opts.summary, tags: opts.tags }, now)
  return { ...note, path: `${dir}/${name}.md` }
}
