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
 * nodes rendered as `<a class="wikilink" data-target=...>`.
 */
export const remarkWikilink: Plugin<[RemarkWikilinkOptions?], Root> = (options = {}) => {
  const resolve = options.resolve
  return (tree, file) => {
    const doc = typeof file?.value === 'string' ? file.value : null
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined) return
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      const tokens = textWikilinks(node.value, doc !== null && start !== undefined && end !== undefined ? doc.slice(start, end) : null)
      if (tokens.length === 0) return
      const pieces: PhrasingContent[] = []
      let cursor = 0
      for (const t of tokens) {
        if (t.index > cursor) pieces.push({ type: 'text', value: node.value.slice(cursor, t.index) })
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
        pieces.push(wl)
        cursor = t.index + t.match.length
      }
      if (cursor < node.value.length) pieces.push({ type: 'text', value: node.value.slice(cursor) })
      parent.children.splice(index, 1, ...pieces)
      return index + pieces.length
    })
  }
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
      const src = doc.slice(start, end)
      if (!src.includes('\\#')) return
      // Escapes never add or drop a `#`: the value's hashes are the source's, in order.
      const escaped: boolean[] = []
      for (let i = 0; i < src.length; i++) {
        if (src[i] !== '#') continue
        let slashes = 0
        for (let j = i - 1; j >= 0 && src[j] === '\\'; j--) slashes++
        escaped.push(slashes % 2 === 1)
      }
      const hashes: number[] = []
      for (let i = 0; i < node.value.length; i++) if (node.value[i] === '#') hashes.push(i)
      if (hashes.length !== escaped.length) return
      const pieces: PhrasingContent[] = []
      let cursor = 0
      hashes.forEach((at, k) => {
        if (!escaped[k]) return
        if (at > cursor) pieces.push({ type: 'text', value: node.value.slice(cursor, at) })
        pieces.push({
          type: 'literalHash',
          data: { hName: 'span', hProperties: { className: 'literal-hash' } },
          children: [{ type: 'text', value: '#' }],
        } as unknown as PhrasingContent)
        cursor = at + 1
      })
      if (!pieces.length) return
      if (cursor < node.value.length) pieces.push({ type: 'text', value: node.value.slice(cursor) })
      parent.children.splice(index, 1, ...pieces)
      return index + pieces.length
    })
  }
}
