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
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined) return
      const tokens = tokenizeWikilinks(node.value)
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
