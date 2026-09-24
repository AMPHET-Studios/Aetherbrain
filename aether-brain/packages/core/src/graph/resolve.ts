import type { NoteId, ParsedNote } from '../types'
import { basenameOf, normalizePath } from '../vault/paths'

/**
 * Title/alias/path index used to turn `[[Some Target]]` into a NoteId.
 * Resolution order (Obsidian-compatible):
 *   1. exact vault path / id (`Daily/2026-09-16`, `Daily/2026-09-16.md`)
 *   2. title (case-insensitive)
 *   3. alias (case-insensitive)
 *   4. filename (case-insensitive) — unique basename wins, else shortest path
 */
export class LinkResolver {
  private byId = new Map<string, NoteId>()
  private byTitle = new Map<string, NoteId>()
  private byAlias = new Map<string, NoteId>()
  private byBasename = new Map<string, NoteId[]>()

  constructor(notes: Iterable<ParsedNote>) {
    for (const n of notes) this.add(n)
  }

  add(n: ParsedNote): void {
    const id = n.meta.id
    this.byId.set(id.toLowerCase(), id)
    const t = n.meta.title.trim().toLowerCase()
    if (t && !this.byTitle.has(t)) this.byTitle.set(t, id)
    for (const a of n.meta.aliases) {
      const k = a.trim().toLowerCase()
      if (k && !this.byAlias.has(k)) this.byAlias.set(k, id)
    }
    const base = basenameOf(n.meta.path).toLowerCase()
    const arr = this.byBasename.get(base)
    if (arr) arr.push(id)
    else this.byBasename.set(base, [id])
  }

  resolve(target: string): NoteId | null {
    const raw = target.trim()
    if (!raw) return null
    const norm = normalizePath(raw).replace(/\.md$/i, '').toLowerCase()
    const direct = this.byId.get(norm)
    if (direct) return direct
    const lower = raw.toLowerCase()
    const byTitle = this.byTitle.get(lower)
    if (byTitle) return byTitle
    const byAlias = this.byAlias.get(lower)
    if (byAlias) return byAlias
    const base = basenameOf(raw).toLowerCase()
    const cands = this.byBasename.get(base)
    if (cands && cands.length) {
      if (cands.length === 1) return cands[0] ?? null
      return [...cands].sort((a, b) => a.length - b.length)[0] ?? null
    }
    return null
  }
}
