import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { toString as mdToString } from 'mdast-util-to-string'
import type { Root, Heading as MdHeading, Text } from 'mdast'
import type { Heading, Link, NoteMeta, ParsedNote, VaultFile } from '../types'
import { asIsoDate, asString, asStringArray, splitFrontmatter } from './frontmatter'
import { tokenizeWikilinks } from './wikilink'
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

const processor = unified().use(remarkParse).use(remarkGfm)

/** Parse markdown into an mdast tree (cached processor, no stringify). */
export function parseMarkdown(body: string): Root {
  return processor.parse(tameNesting(body)) as Root
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
  const tree = parseMarkdown(body)

  const headings: Heading[] = []
  let firstH1: string | null = null
  const textChunks: string[] = []
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
      const base = t.position?.start.offset ?? 0
      for (const tok of tokenizeWikilinks(t.value)) {
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
  const inlineTags = extractInlineTags(textChunks.join('\n'))
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
