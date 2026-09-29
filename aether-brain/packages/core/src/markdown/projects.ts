/**
 * Projects as editable stars.
 *
 * A project is a plain markdown note (`type: project`, or a note sitting in
 * the Projects area folder). Its *home folder* holds the project's files; in
 * the system layout that folder is the star and its subfolders are planets.
 * Everything here reads and rewrites ordinary markdown — no sidecar files.
 */
import type { Frontmatter, ParsedNote, VaultRootInfo } from '../types'
import { asString, asStringArray, rewriteFrontmatter, splitFrontmatter } from './frontmatter'
import { normalizeTag } from './parse'
import { atxHeading, projectNote } from './tasks'
import { areaFromFolder, areaOfFolderName, basenameOf, folderOf, mountOf, normalizeFolderPath, topFolderOf } from '../vault/paths'

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
 *  1. frontmatter `folder:`, normalized. It is written relative to the note's
 *     root (see `portableFolderRef`), so it is resolved against `folders` as
 *     written (`F/Games/X` on another drive, or a single-root vault), then
 *     under the note's first path segment (`D/` + `Games/X`: its mount in a
 *     multi-root vault), then without its first segment (a full path written
 *     while more drives were open). The last two apply only when the value's
 *     first segment is not a folder of the vault; when it is, the value is a
 *     plain vault path that does not exist yet. None existing, it is returned
 *     as written so the UI can offer to create it;
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
    if (f) {
      if (folders.has(f)) return f
      // Only a value whose first segment is no folder here can be mount-shifted:
      // `Projects/Game` (not created yet) in a vault with a `Projects` folder
      // means exactly that, never an unrelated top-level `Game`.
      const cut = f.indexOf('/')
      if (!folders.has(cut < 0 ? f : f.slice(0, cut))) {
        const first = topFolderOf(note.meta.path)
        if (first && folders.has(`${first}/${f}`)) return `${first}/${f}`
        if (cut > 0 && folders.has(f.slice(cut + 1))) return f.slice(cut + 1)
      }
      return f
    }
  }
  const base = basenameOf(note.meta.path)
  const folder = note.meta.folder
  if (folder && lastSegment(folder).toLowerCase() === base.toLowerCase()) return folder
  const sibling = folder ? `${folder}/${base}` : base
  return folders.has(sibling) ? sibling : null
}

/**
 * The value to store in a project note's `folder:` for its home folder
 * `folderPath` (a vault path): relative to the note's root, so the binding
 * survives drives being added or removed. In a multi-root vault a folder on
 * the note's own drive drops the mount (`D/Games/X` → `Games/X` for
 * `D/Projects/X.md`); a folder on another drive, the drive itself, a folder
 * whose relative path would start with another root's mount (`D/F/Games`),
 * or any folder of a single-root vault keeps its full vault path.
 * `projectFolderOf` resolves either form.
 */
export function portableFolderRef(notePath: string, folderPath: string, roots?: VaultRootInfo[] | null): string {
  const folder = normalizeFolderPath(folderPath)
  const mount = mountOf(notePath, roots)
  if (!mount || !folder.startsWith(`${mount}/`)) return folder
  const rel = folder.slice(mount.length + 1)
  // `D/F/Games` must not become `F/Games`, which reads as drive F's folder.
  const head = (rel.split('/', 1)[0] ?? '').toLowerCase()
  return roots?.some((r) => r.mount.toLowerCase() === head) ? folder : rel
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

/** The text of an ATX H1 line (`# **PORTALz**` → `**PORTALz**`), or null. Linear time. */
function h1Of(line: string): string | null {
  const h = atxHeading(line)
  return h?.level === 1 ? h.text : null
}

/** Index of the first ATX H1 outside fenced code, or -1. */
function findH1(lines: string[]): number {
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const l = textOf(lines[i] ?? '')
    if (FENCE_RE.test(l)) inFence = !inFence
    else if (!inFence && h1Of(l) !== null) return i
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
  // Blank, comment, `---` or `...` lines hold nothing (trim, not a regex: linear on long lines).
  return block.some((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('#') && t !== '---' && t !== '...'
  })
}

/** Aliases as written: a list, or one string of comma-separated aliases (`aliases: Portal game`). */
function aliasList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(',').map((a) => a.trim()).filter(Boolean)
  return asStringArray(v)
}

/** What `setProjectFields` should know about the note beyond its text. */
export interface ProjectFieldOptions {
  /**
   * The note's current title as the app resolves it (`meta.title`: frontmatter
   * title, else the first H1 — setext too — else the file name). Kept as an
   * alias on a rename even when the text alone can't tell it.
   */
  oldTitle?: string
  /**
   * More names to keep resolving after a rename, e.g. the old file name when
   * the file is renamed too (`[[portal-game]]` resolved by basename).
   */
  keepAliases?: string[]
}

/**
 * Rewrite a project note.
 *  - title: frontmatter `title` + the first H1; the old title (frontmatter
 *    title, else `opts.oldTitle`, else the H1) and `opts.keepAliases` are
 *    appended to `aliases` (deduplicated, case-insensitively like link
 *    resolution) so existing [[links]] keep resolving; an alias equal to the
 *    new title goes.
 *  - summary: replaces the `>` blockquote right after the H1, inserts one
 *    after the H1 when missing, removes it for '' / null.
 *  - status / tags / folder: frontmatter keys; null (or '') deletes the key.
 * The rest of the body stays byte-identical (every line keeps its own
 * ending). Frontmatter keys are patched in place (`rewriteFrontmatter`):
 * comments and the keys not edited keep their exact text, and new lines
 * follow the file's CRLF / LF. Throws instead of rewriting a frontmatter
 * block whose YAML does not parse.
 */
export function setProjectFields(raw: string, patch: ProjectPatch, opts: ProjectFieldOptions = {}): string {
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

  // Keys to rewrite, in order; `undefined` deletes (see rewriteFrontmatter).
  const fmPatch: Record<string, unknown> = {}
  const setKey = (key: string, value: unknown): void => {
    if (value === null) {
      if (key in fm) {
        delete fm[key]
        fmPatch[key] = undefined
        fmChanged = true
      }
    } else if (!sameValue(fm[key], value)) {
      fm[key] = value
      fmPatch[key] = value
      fmChanged = true
    }
  }

  const title = patch.title?.replace(/\s+/g, ' ').trim()
  const h1Raw = h1 >= 0 ? h1Of(textOf(lines[h1] ?? '')) : null
  // The H1 as the note's title reads (`# **PORTALz**` → PORTALz), like parseNote.
  const h1Text = h1Raw === null ? null : plainInline(h1Raw)
  const given = opts.oldTitle?.replace(/\s+/g, ' ').trim() || null
  const old = asString(fm['title']) ?? given ?? h1Text
  // Only a real change touches anything: saving the current title is a no-op.
  if (title && title !== old) {
    setKey('title', title)
    if (h1Text !== null && h1Text !== title) {
      lines[h1] = `# ${title}${eolOf(lines[h1])}`
      bodyChanged = true
    }
    // Every name the note answered to keeps resolving: its title, and what
    // the caller knows (the old file name when that changes too).
    const keep = [old, given, ...(opts.keepAliases ?? [])]
      .map((a) => a?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
    if (keep.length) {
      // Case-insensitive like link resolution: the title itself already resolves.
      const seen = new Set([title.toLowerCase()])
      const aliases: string[] = []
      for (const a of [...aliasList(fm['aliases']), ...keep]) {
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
  return rewriteFrontmatter(raw, fmPatch, body)
}

/** Markdown inline syntax → readable text for cards (wikilinks, links, emphasis, code). */
function plainInline(text: string): string {
  return text
    // `[^[\]]`: a run of brackets must not make these scans quadratic.
    .replace(/!?\[\[([^[\]]+?)\]\]/g, (_m, inner: string) => {
      const pipe = inner.indexOf('|')
      if (pipe >= 0) return inner.slice(pipe + 1).trim()
      const hash = inner.indexOf('#')
      return (hash >= 0 ? inner.slice(0, hash) : inner).trim()
    })
    .replace(/!?\[([^[\]]*)\]\([^()]*\)/g, '$1')
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
