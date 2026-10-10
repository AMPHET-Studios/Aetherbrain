import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { toString as mdToString } from 'mdast-util-to-string'
import type { Root, Heading as MdHeading, Text } from 'mdast'
import type { Heading, Link, NoteMeta, ParsedNote, VaultFile } from '../types'
import { asIsoDate, asString, asStringArray, splitFrontmatter } from './frontmatter'
import { boardNoteParts } from '../board/format'
import { remarkNoLateAutolinks, textTags, textWikilinks } from './wikilink'
import {
  areaFromFolder,
  basenameOf,
  folderOf,
  idFromPath,
  isArea,
  isDailyName,
  isNoteType,
  normalizePath,
  typeFromFolder,
} from '../vault/paths'

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkNoLateAutolinks)

/** Parse markdown into an mdast tree (cached processor, no stringify). */
export function parseMarkdown(body: string): Root {
  return processor.parse(tameDelimiters(tameNesting(body))) as Root
}

/** Most emphasis delimiters (`*`, `_`) a paragraph keeps for parsing (see `tameDelimiters`). */
export const PARSE_MAX_DELIMITERS = 2000

/**
 * micromark takes quadratic time on long runs of emphasis delimiters in one
 * paragraph (4,000 unmatched `*` or `_`: most of a second; 40,000: minutes,
 * with the app frozen). In a paragraph (a run of lines without a blank one)
 * holding more than PARSE_MAX_DELIMITERS of them, each is swapped for a
 * look-alike that is no delimiter (`∗`, `＿`): same length, so every offset
 * stays true; that paragraph just loses its emphasis. Real notes stay far
 * below the limit.
 */
export function tameDelimiters(body: string): string {
  let count = 0
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    if (c === 42 || c === 95) count++
  }
  if (count <= PARSE_MAX_DELIMITERS) return body
  const lines = body.split('\n')
  let start = 0
  let changed = false
  const paragraph = (end: number) => {
    let n = 0
    for (let i = start; i < end; i++) for (const ch of lines[i]!) if (ch === '*' || ch === '_') n++
    if (n <= PARSE_MAX_DELIMITERS) return
    changed = true
    for (let i = start; i < end; i++) lines[i] = lines[i]!.replace(/\*/g, '\u2217').replace(/_/g, '\uff3f')
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) {
      paragraph(i)
      start = i + 1
    }
  }
  paragraph(lines.length)
  return changed ? lines.join('\n') : body
}

/** Deepest list / blockquote nesting kept for parsing; real notes stay far below it. */
const MAX_NEST = 32

/**
 * micromark recurses once per container level, so a line like `- - - - …`
 * thousands deep takes seconds and then overflows the stack. Blank the markers
 * past MAX_NEST on such lines (same length, so every offset stays true); the
 * rest of the line then parses as plain indented text.
 */
function tameNesting(body: string): string {
  if (body.length < MAX_NEST * 2) return body
  let lines: string[] | null = null
  let start = 0
  for (let n = 0; start <= body.length; n++) {
    let end = body.indexOf('\n', start)
    if (end < 0) end = body.length
    let depth = 0
    let cut = -1
    for (let j = start; j < end; j++) {
      const c = body.charCodeAt(j)
      if (c === 32 || c === 9) continue
      const next = body.charCodeAt(j + 1)
      const marker = c === 62 || ((c === 45 || c === 42 || c === 43) && (next === 32 || next === 9))
      if (!marker) break
      if (++depth === MAX_NEST) cut = j + 1
    }
    if (cut > 0 && depth > MAX_NEST) {
      lines ??= body.split('\n')
      const line = lines[n] ?? ''
      const at = cut - start
      let k = at
      while (k < line.length && /[\s>*+-]/.test(line[k] ?? '')) k++
      lines[n] = line.slice(0, at) + ' '.repeat(k - at) + line.slice(k)
    }
    start = end + 1
  }
  return lines ? lines.join('\n') : body
}

export function slugifyHeading(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

const INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu

export function extractInlineTags(text: string): string[] {
  const out = new Set<string>()
  INLINE_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_TAG_RE.exec(text))) {
    const tag = m[2] ?? ''
    if (!tag || /^\d+$/.test(tag)) continue
    out.add(tag.toLowerCase())
  }
  return [...out]
}

/** Offsets of the `#` of every inline tag in `text` (what `extractInlineTags` would read). */
export function inlineTagOffsets(text: string): number[] {
  const out: number[] = []
  INLINE_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_TAG_RE.exec(text))) {
    const tag = m[2] ?? ''
    if (tag && !/^\d+$/.test(tag)) out.push(m.index + (m[1] ?? '').length)
  }
  return out
}


export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').trim().toLowerCase()
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)
  return m ? m.length : 0
}

/**
 * Parse a single vault file into a ParsedNote. Links are left unresolved here
 * (`resolved: false`, `to` = raw target); `buildGraph` resolves them across the
 * whole vault because resolution needs every title + alias.
 */
export function parseNote(file: VaultFile): ParsedNote {
  const path = normalizePath(file.path)
  const id = idFromPath(path)
  const { frontmatter, body } = splitFrontmatter(file.content)
  // A board's item lines are the board's data, not prose: the board's own line scan reads them (a few milliseconds for a full board),
  // never the markdown parser (0.3 to 0.8 s, on every save), and none of their text becomes links, tags or search text. What the user
  // wrote in the note and the lines the board keeps as extras are prose and go through the parser as before.
  const board = frontmatter['type'] === 'board' ? boardNoteParts(body) : null
  const text = board ? board.text : body
  const tree = parseMarkdown(text)

  const headings: Heading[] = []
  let firstH1: string | null = null
  const textChunks: string[] = []
  const tagSet = new Set<string>()
  const links: Link[] = []

  visit(tree, (node) => {
    if (node.type === 'heading') {
      const h = node as MdHeading
      const text = mdToString(h).trim()
      if (text) {
        headings.push({ depth: h.depth, text, slug: slugifyHeading(text) })
        if (h.depth === 1 && firstH1 === null) firstH1 = text
      }
    }
    if (node.type === 'text') {
      const t = node as Text
      textChunks.push(t.value)
      const start = t.position?.start.offset
      const end = t.position?.end.offset
      // Links and tags are read from the markdown as written, so escaped
      // brackets and hashes (`[\[x]]`, `\#word`) stay plain text.
      const source = start !== undefined && end !== undefined ? text.slice(start, end) : null
      for (const { tag } of textTags(t.value, source)) tagSet.add(tag)
      const base = board ? board.original(start ?? 0) : (start ?? 0)
      for (const tok of textWikilinks(t.value, source)) {
        const link: Link = {
          from: id,
          to: tok.target,
          raw: tok.raw,
          kind: tok.embed ? 'embed' : 'wikilink',
          resolved: false,
          offset: base + tok.index,
        }
        if (tok.heading) link.heading = slugifyHeading(tok.heading)
        if (tok.alias) link.alias = tok.alias
        links.push(link)
      }
    }
  })

  // A paragraph `tameDelimiters` guarded holds look-alikes for its * and _ : links and search text get them back.
  if (tameDelimiters(text) !== text) {
    const back = (x: string) => x.replace(/\u2217/g, '*').replace(/\uff3f/g, '_')
    for (const l of links) {
      l.to = back(l.to)
      l.raw = back(l.raw)
      if (l.alias) l.alias = back(l.alias)
      if (l.heading) l.heading = back(l.heading)
    }
    for (let i = 0; i < textChunks.length; i++) textChunks[i] = back(textChunks[i]!)
  }

  // The pictures of a board, from its lines (an embed is a link like any other; a `pic` line names a picture whose path cannot be
  // written as a wikilink, so its link is marked to be read as the path it is). Merged in by position.
  if (board && board.pictures.length > 0) {
    const merged: Link[] = []
    let k = 0
    for (const p of board.pictures) {
      while (k < links.length && links[k]!.offset <= p.offset) merged.push(links[k++]!)
      const link: Link = { from: id, to: p.path, raw: p.path, kind: 'embed', resolved: false, offset: p.offset }
      if (p.literal) link.literal = true
      merged.push(link)
    }
    while (k < links.length) merged.push(links[k++]!)
    links.splice(0, links.length, ...merged)
  }

  // Plain text for search/mentions: strip wikilink syntax but keep the words.
  // `[^[\]]` like WIKILINK_RE: a long run of `[[` must not make this quadratic.
  const plain = textChunks
    .join(' ')
    .replace(/!?\[\[([^[\]]+?)\]\]/g, (_m, inner: string) => {
      const { target, alias } = splitRaw(inner)
      return alias ?? target
    })
    .replace(/\s+/g, ' ')
    .trim()

  const fmTags = asStringArray(frontmatter['tags']).map(normalizeTag).filter(Boolean)
  const inlineTags = [...tagSet]
  const tags = uniq([...fmTags, ...inlineTags])

  const fmTitle = asString(frontmatter['title'])
  const filename = basenameOf(path)
  const title = fmTitle ?? firstH1 ?? filename

  const fmArea = frontmatter['area']
  const area = isArea(fmArea) ? fmArea : (areaFromFolder(path) ?? 'untagged')

  const fmType = frontmatter['type']
  const type = isNoteType(fmType)
    ? fmType
    : (typeFromFolder(path) ?? (isDailyName(filename) ? 'daily' : area === 'inbox' ? 'inbox' : 'note'))

  const aliases = uniq(asStringArray(frontmatter['aliases']).concat(asStringArray(frontmatter['alias'])))

  const meta: NoteMeta = {
    id,
    title,
    path,
    folder: folderOf(path),
    area,
    type,
    tags,
    created: asIsoDate(frontmatter['created'] ?? frontmatter['date']),
    updated: asIsoDate(frontmatter['updated'] ?? frontmatter['modified']) ?? (file.mtime ? new Date(file.mtime).toISOString() : null),
    status: asString(frontmatter['status']),
    wordCount: countWords(plain),
    headings,
    aliases,
  }

  const parsed: ParsedNote = {
    meta,
    frontmatter,
    body,
    raw: file.content,
    links,
    inlineTags,
    plain,
  }
  if (file.mtime !== undefined) parsed.mtime = file.mtime
  return parsed
}

function splitRaw(inner: string): { target: string; alias?: string } {
  const pipe = inner.indexOf('|')
  const left = pipe >= 0 ? inner.slice(0, pipe) : inner
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined
  const hash = left.indexOf('#')
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim()
  return alias ? { target, alias } : { target }
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
