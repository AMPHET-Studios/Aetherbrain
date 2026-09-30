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

/** CommonMark backslash escapes resolved (`\[` → `[`): what a text node's value holds for its source. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

/**
 * The wikilinks of a markdown text node that are really written in its
 * source. `value` is the node's text (escapes resolved); `source` is the
 * markdown the node was parsed from. An escaped bracket (`[\[x]]`,
 * `\[\[x]]`) is how markdown writes a literal `[[`, so it is not a link
 * (imported AI chats rely on this). Escapes inside a link still count
 * (`[[Note\|alias]]` in a table cell). Tokens keep their index in `value`.
 */
export function textWikilinks(value: string, source?: string | null): WikilinkToken[] {
  const tokens = tokenizeWikilinks(value)
  if (!tokens.length || source == null || source === value) return tokens
  const written = tokenizeWikilinks(source).map((t) => `${t.embed ? '!' : ''}${unescapeMarkdown(t.raw)}`)
  const out: WikilinkToken[] = []
  let from = 0
  for (const t of tokens) {
    const at = written.indexOf(`${t.embed ? '!' : ''}${t.raw}`, from)
    if (at < 0) continue
    from = at + 1
    out.push(t)
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

/**
 * Indices in a text node's `value` of the hashes its `source` writes escaped
 * (`\#word`). Escapes never add or drop a `#`, so the value's hashes are the
 * source's, in order; when the counts differ (a `&#35;` entity) nothing is
 * reported.
 */
function literalHashes(value: string, source: string): number[] {
  if (!source.includes('\\#')) return []
  const escaped: boolean[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '#') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) slashes++
    escaped.push(slashes % 2 === 1)
  }
  const out: number[] = []
  let k = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '#') continue
    if (escaped[k]) out.push(i)
    k++
  }
  return k === escaped.length ? out : []
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
