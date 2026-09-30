/**
 * Wikilink tokenizer + remark plugin.
 *
 * Supported forms (Obsidian-compatible, nothing proprietary):
 *   [[Note Title]]
 *   [[Note Title|alias]]
 *   [[Note Title#Heading]]
 *   [[Note Title#Heading|alias]]
 *   ![[Note Title]]           (embed)
 *
 * Tokenizing happens on mdast `text` nodes, so anything inside fenced code,
 * inline code, or html is ignored for free.
 */
import type { Root, Text, Parent, PhrasingContent } from 'mdast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

export interface WikilinkToken {
  /** Full match including brackets and leading `!`. */
  match: string
  /** Text between the brackets. */
  raw: string
  target: string
  heading?: string
  alias?: string
  embed: boolean
  /** Offset within the scanned string. */
  index: number
}

export const WIKILINK_RE = /(!?)\[\[([^\[\]]+?)\]\]/g

export function parseWikilinkRaw(raw: string): { target: string; heading?: string; alias?: string } {
  let text = raw
  let alias: string | undefined
  const pipe = text.indexOf('|')
  if (pipe >= 0) {
    alias = text.slice(pipe + 1).trim()
    text = text.slice(0, pipe)
  }
  let heading: string | undefined
  const hash = text.indexOf('#')
  if (hash >= 0) {
    heading = text.slice(hash + 1).trim()
    text = text.slice(0, hash)
  }
  const target = text.trim()
  const out: { target: string; heading?: string; alias?: string } = { target }
  if (heading) out.heading = heading
  if (alias) out.alias = alias
  return out
}

/** Tokenize every wikilink in a plain string (no code awareness). */
export function tokenizeWikilinks(text: string): WikilinkToken[] {
  const out: WikilinkToken[] = []
  WIKILINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(text))) {
    const raw = m[2] ?? ''
    const parsed = parseWikilinkRaw(raw)
    if (!parsed.target && !parsed.heading) continue
    out.push({
      match: m[0],
      raw,
      target: parsed.target,
      ...(parsed.heading ? { heading: parsed.heading } : {}),
      ...(parsed.alias ? { alias: parsed.alias } : {}),
      embed: m[1] === '!',
      index: m.index,
    })
  }
  return out
}

/** Character references that stand for the characters escapes care about (named ones are case-sensitive). */
const NAMED_REFS: Record<string, number> = { lsqb: 91, lbrack: 91, rsqb: 93, rbrack: 93, num: 35 }

/** Where one character of a text node's value came from in its markdown source. */
export interface CharOrigin {
  /** Written escaped (`\[`, `\#`) or as a character reference (`&#91;`): text, never syntax. */
  escaped: boolean
  /** Offset in the source of the character, or of its escape or reference. */
  at: number
}

/**
 * For each occurrence of `ch` in a text node's `value`, in order: whether its
 * markdown `source` wrote it escaped or as a character reference, and where.
 * Escapes and references never add or drop a character, so the value's
 * occurrences are the source's, in order; null when the two don't line up
 * (the caller then trusts the value, as before escapes were read).
 */
export function charOrigins(value: string, source: string, ch: string): CharOrigin[] | null {
  const code = ch.charCodeAt(0)
  const found: CharOrigin[] = []
  for (let i = 0; i < source.length; ) {
    const c = source[i]
    if (c === '\\' && i + 1 < source.length && /[!-/:-@[-`{-~]/.test(source[i + 1]!)) {
      if (source[i + 1] === ch) found.push({ escaped: true, at: i })
      i += 2
      continue
    }
    if (c === '&') {
      const m = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(source.slice(i, i + 40))
      if (m) {
        const n = m[1] ? Number(m[1]) : m[2] ? parseInt(m[2], 16) : (NAMED_REFS[m[3]!] ?? -1)
        if (n === code) found.push({ escaped: true, at: i })
        i += m[0].length
        continue
      }
    }
    if (c === ch) found.push({ escaped: false, at: i })
    i++
  }
  let count = 0
  for (let i = 0; i < value.length; i++) if (value[i] === ch) count++
  return count === found.length ? found : null
}

/** For each index of `value`, the ordinal of `ch` there among the value's occurrences of `ch` (-1 elsewhere). */
function ordinals(value: string, ch: string): Int32Array {
  const out = new Int32Array(value.length).fill(-1)
  let k = 0
  for (let i = 0; i < value.length; i++) if (value[i] === ch) out[i] = k++
  return out
}

/**
 * The wikilinks of a markdown text node that are really written in its
 * source. `value` is the node's text (escapes and references resolved);
 * `source` is the markdown the node was parsed from. A bracket written
 * escaped (`[\[x]]`, `\[\[x\]\]`) or as `&#91;` is text, so a link it would
 * open is no link (imported AI chats rely on this). Tokens keep their index
 * in `value`.
 */
export function textWikilinks(value: string, source?: string | null): WikilinkToken[] {
  const tokens = tokenizeWikilinks(value)
  if (!tokens.length || source == null || source === value) return tokens
  const origins = charOrigins(value, source, '[')
  if (!origins) return tokens
  const ord = ordinals(value, '[')
  return tokens.filter((t) => {
    const first = t.index + (t.embed ? 1 : 0)
    return !origins[ord[first]!]?.escaped && !origins[ord[first + 1]!]?.escaped
  })
}

/**
 * The source offsets of each token's brackets (`[[` and `]]`), to escape
 * them, from one look at the node; null when they can't be told apart.
 */
export function wikilinkBrackets(value: string, source: string, tokens: WikilinkToken[]): number[][] | null {
  const opens = charOrigins(value, source, '[')
  const closes = charOrigins(value, source, ']')
  if (!opens || !closes) return null
  const o = ordinals(value, '[')
  const c = ordinals(value, ']')
  const out: number[][] = []
  for (const t of tokens) {
    const first = t.index + (t.embed ? 1 : 0)
    const last = t.index + t.match.length - 1
    const at = [opens[o[first]!]?.at, opens[o[first + 1]!]?.at, closes[c[last - 1]!]?.at, closes[c[last]!]?.at]
    if (!at.every((x): x is number => x !== undefined)) return null
    out.push(at)
  }
  return out
}

/**
 * Inline tags of a text node (lowercased, without `#`) and where their `#`
 * is in `value`, as `extractInlineTags` reads the value, less those whose
 * `#` the source wrote escaped (`\#word`) or as a reference: that is how
 * markdown writes a literal hash.
 */
export function textTags(value: string, source?: string | null): { tag: string; index: number }[] {
  const out: { tag: string; index: number }[] = []
  if (!value.includes('#')) return out
  const origins = source == null || source === value ? null : charOrigins(value, source, '#')
  const ord = origins ? ordinals(value, '#') : null
  const re = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(value))) {
    const tag = m[2] ?? ''
    if (!tag || /^\d+$/.test(tag)) continue
    const at = m.index + (m[1] ?? '').length
    if (origins && ord && origins[ord[at]!]?.escaped) continue
    out.push({ tag: tag.toLowerCase(), index: at })
  }
  return out
}

/** Indices in a text node's `value` of the hashes its `source` writes escaped (`\#word`, `&#35;`). */
function literalHashes(value: string, source: string): number[] {
  if (!value.includes('#')) return []
  const origins = charOrigins(value, source, '#')
  if (!origins) return []
  const out: number[] = []
  let k = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '#') continue
    if (origins[k]?.escaped) out.push(i)
    k++
  }
  return out
}

export interface WikilinkNode {
  type: 'wikilink'
  target: string
  heading?: string
  alias?: string
  embed: boolean
  raw: string
  data: {
    hName: string
    hProperties: Record<string, string | boolean>
  }
  children: PhrasingContent[]
  position?: Text['position']
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikilink: WikilinkNode
  }
  interface RootContentMap {
    wikilink: WikilinkNode
  }
}

export interface RemarkWikilinkOptions {
  /** Return a resolved note id (or null) for a target — used to mark ghosts. */
  resolve?: (target: string) => string | null
}

/**
 * remark plugin: splits text nodes containing [[wikilinks]] into `wikilink`
 * nodes rendered as `<a class="wikilink" data-target=...>`, and sets apart
 * escaped hashes as `remarkLiteralHashes` does (both need the node's source
 * position, which the pieces of a split no longer have).
 */
export const remarkWikilink: Plugin<[RemarkWikilinkOptions?], Root> = (options = {}) => {
  const resolve = options.resolve
  return (tree, file) => {
    const doc = typeof file?.value === 'string' ? file.value : null
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined) return
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      const source = doc !== null && start !== undefined && end !== undefined ? doc.slice(start, end) : null
      const tokens = textWikilinks(node.value, source)
      // Escaped hashes are split out here too, in the same pass: the pieces a split leaves have no position.
      const hashes = source === null ? [] : literalHashes(node.value, source).filter((at) => !tokens.some((t) => at >= t.index && at < t.index + t.match.length))
      if (tokens.length === 0 && hashes.length === 0) return
      const cuts: ({ at: number; len: number; node: PhrasingContent })[] = []
      for (const t of tokens) {
        const resolved = resolve ? resolve(t.target) : null
        const label = t.alias ?? (t.heading && !t.target ? `#${t.heading}` : t.heading ? `${t.target} › ${t.heading}` : t.target)
        const props: Record<string, string | boolean> = {
          className: `wikilink${t.embed ? ' wikilink-embed' : ''}${resolve && !resolved ? ' wikilink-ghost' : ''}`,
          'data-target': t.target,
          'data-embed': t.embed ? 'true' : 'false',
          href: '#',
        }
        if (resolved) props['data-id'] = resolved
        if (t.heading) props['data-heading'] = t.heading
        const wl: WikilinkNode = {
          type: 'wikilink',
          target: t.target,
          embed: t.embed,
          raw: t.raw,
          data: { hName: 'a', hProperties: props },
          children: [{ type: 'text', value: label }],
        }
        if (t.heading) wl.heading = t.heading
        if (t.alias) wl.alias = t.alias
        cuts.push({ at: t.index, len: t.match.length, node: wl })
      }
      for (const at of hashes) cuts.push({ at, len: 1, node: literalHashNode() })
      cuts.sort((a, b) => a.at - b.at)
      const pieces: PhrasingContent[] = []
      let cursor = 0
      for (const c of cuts) {
        if (c.at > cursor) pieces.push({ type: 'text', value: node.value.slice(cursor, c.at) })
        pieces.push(c.node)
        cursor = c.at + c.len
      }
      if (cursor < node.value.length) pieces.push({ type: 'text', value: node.value.slice(cursor) })
      parent.children.splice(index, 1, ...pieces)
      return index + pieces.length
    })
  }
}

function literalHashNode(): PhrasingContent {
  return {
    type: 'literalHash',
    data: { hName: 'span', hProperties: { className: 'literal-hash' } },
    children: [{ type: 'text', value: '#' }],
  } as unknown as PhrasingContent
}

/**
 * remark plugin: a hash written escaped (`\\#word`) is text, not a tag (see
 * `parseNote`). Its `#` is set apart in a `<span class="literal-hash">`, so a
 * renderer that turns `#word` in text into tag links (the preview) leaves it
 * alone, as the graph does. Imported AI chats rely on this.
 */
export const remarkLiteralHashes: Plugin<[], Root> = () => {
  return (tree, file) => {
    const doc = typeof file?.value === 'string' ? file.value : null
    if (doc === null || !doc.includes('\\#')) return
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || !node.value.includes('#')) return
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) return
      const hashes = literalHashes(node.value, doc.slice(start, end))
      if (!hashes.length) return
      const pieces: PhrasingContent[] = []
      let cursor = 0
      for (const at of hashes) {
        if (at > cursor) pieces.push({ type: 'text', value: node.value.slice(cursor, at) })
        pieces.push(literalHashNode())
        cursor = at + 1
      }
      if (cursor < node.value.length) pieces.push({ type: 'text', value: node.value.slice(cursor) })
      parent.children.splice(index, 1, ...pieces)
      return index + pieces.length
    })
  }
}
