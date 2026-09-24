import MiniSearch, { type SearchResult } from 'minisearch'
import type { NoteId, ParsedNote, SearchHit } from '../types'

interface Doc {
  id: NoteId
  title: string
  aliases: string
  headings: string
  tags: string
  body: string
  path: string
}

export interface SearchOptions {
  limit?: number
  /** Restrict to these ids (e.g. after area/tag filtering). */
  within?: Set<NoteId> | null
  prefix?: boolean
  fuzzy?: number | boolean
}

/**
 * MiniSearch wrapper over title, aliases, headings, tags, body and path.
 * Incremental: `upsert`/`remove` keep the index in sync with vault changes.
 */
export class SearchIndex {
  private ms: MiniSearch<Doc>
  private docs = new Map<NoteId, Doc>()

  constructor() {
    this.ms = new MiniSearch<Doc>({
      fields: ['title', 'aliases', 'headings', 'tags', 'body', 'path'],
      storeFields: ['title'],
      searchOptions: {
        boost: { title: 6, aliases: 5, tags: 4, headings: 3, path: 1.5, body: 1 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
      tokenize: (text) => text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean),
    })
  }

  get size(): number {
    return this.docs.size
  }

  private toDoc(n: ParsedNote): Doc {
    return {
      id: n.meta.id,
      title: n.meta.title,
      aliases: n.meta.aliases.join(' '),
      headings: n.meta.headings.map((h) => h.text).join(' \n '),
      tags: n.meta.tags.join(' '),
      body: n.plain,
      path: n.meta.path.replace(/[\/_-]+/g, ' '),
    }
  }

  rebuild(notes: Iterable<ParsedNote>): void {
    this.ms.removeAll()
    this.docs.clear()
    const docs: Doc[] = []
    for (const n of notes) {
      const d = this.toDoc(n)
      this.docs.set(d.id, d)
      docs.push(d)
    }
    this.ms.addAll(docs)
  }

  upsert(n: ParsedNote): void {
    const d = this.toDoc(n)
    if (this.docs.has(d.id)) this.ms.discard(d.id)
    this.docs.set(d.id, d)
    this.ms.add(d)
  }

  remove(id: NoteId): void {
    if (!this.docs.has(id)) return
    this.ms.discard(id)
    this.docs.delete(id)
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const q = query.trim()
    if (!q) return []
    const limit = opts.limit ?? 20
    const within = opts.within ?? null
    const results = this.ms.search(q, {
      prefix: opts.prefix ?? true,
      fuzzy: opts.fuzzy ?? 0.2,
      filter: within ? (r: SearchResult) => within.has(r.id as NoteId) : undefined,
    })
    const hits: SearchHit[] = []
    for (const r of results) {
      if (hits.length >= limit) break
      const doc = this.docs.get(r.id as NoteId)
      if (!doc) continue
      const terms = r.queryTerms ?? r.terms
      hits.push({
        id: doc.id,
        score: r.score,
        title: doc.title,
        match: Object.keys(r.match),
        snippet: makeSnippet(doc.body, terms),
      })
    }
    return hits
  }

  /** Cheap title-only completion for [[ autocomplete and the command palette. */
  suggestTitles(prefix: string, limit = 8): { id: NoteId; title: string }[] {
    const p = prefix.trim().toLowerCase()
    const out: { id: NoteId; title: string }[] = []
    if (!p) {
      for (const d of this.docs.values()) {
        out.push({ id: d.id, title: d.title })
        if (out.length >= limit) break
      }
      return out
    }
    const starts: { id: NoteId; title: string }[] = []
    const contains: { id: NoteId; title: string }[] = []
    for (const d of this.docs.values()) {
      const t = d.title.toLowerCase()
      if (t.startsWith(p)) starts.push({ id: d.id, title: d.title })
      else if (t.includes(p) || d.aliases.toLowerCase().includes(p) || d.id.toLowerCase().includes(p))
        contains.push({ id: d.id, title: d.title })
      if (starts.length >= limit) break
    }
    return [...starts, ...contains].slice(0, limit)
  }

  /** Related notes by shared vocabulary — used by Review to suggest links for orphans. */
  related(note: ParsedNote, limit = 6): SearchHit[] {
    const words = [...new Set(`${note.meta.title} ${note.meta.tags.join(' ')} ${note.meta.headings.map((h) => h.text).join(' ')}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3))].slice(0, 12)
    if (words.length === 0) return []
    const results = this.ms.search(words.join(' '), { combineWith: 'OR', prefix: false, fuzzy: false })
    return results
      .filter((r) => r.id !== note.meta.id)
      .slice(0, limit)
      .map((r) => {
        const doc = this.docs.get(r.id as NoteId)
        return {
          id: r.id as NoteId,
          score: r.score,
          title: doc?.title ?? String(r.id),
          match: Object.keys(r.match),
          snippet: doc ? makeSnippet(doc.body, r.queryTerms ?? r.terms) : '',
        }
      })
  }
}

export function makeSnippet(body: string, terms: string[], radius = 70): string {
  if (!body) return ''
  const lower = body.toLowerCase()
  let idx = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0) return body.slice(0, radius * 2).trim() + (body.length > radius * 2 ? '…' : '')
  const start = Math.max(0, idx - radius)
  const end = Math.min(body.length, idx + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`
}
