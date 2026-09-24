import type { Area, GraphData, GraphEdge, GraphNode, Link, NoteId, ParsedNote } from '../types'
import { LinkResolver } from './resolve'

export interface BuildGraphOptions {
  /** Include unresolved link targets as ghost nodes (default true). */
  ghosts?: boolean
}

function toTs(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/**
 * Resolve every link across the vault and build the graph.
 * Mutates `note.links[i].to/resolved` in place so the store has resolved links
 * without a second pass. Deterministic node order: notes sorted by id, then
 * ghosts sorted by id — stable order keeps the worker layout stable across
 * rebuilds.
 */
export function buildGraph(notes: Map<NoteId, ParsedNote>, opts: BuildGraphOptions = {}): GraphData {
  const ghosts = opts.ghosts ?? true
  const resolver = new LinkResolver(notes.values())

  const nodes: GraphNode[] = []
  const index = new Map<NoteId, number>()
  const backlinks = new Map<NoteId, Set<NoteId>>()
  const outlinks = new Map<NoteId, Set<NoteId>>()
  const unresolved = new Map<NoteId, Set<NoteId>>()
  const tagCounts = new Map<string, number>()
  const areaCounts = new Map<Area, number>()

  const ids = [...notes.keys()].sort()
  for (const id of ids) {
    const n = notes.get(id)!
    const node: GraphNode = {
      id,
      title: n.meta.title,
      area: n.meta.area,
      type: n.meta.type,
      tags: n.meta.tags,
      ghost: false,
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      created: toTs(n.meta.created),
      updated: toTs(n.meta.updated),
      wordCount: n.meta.wordCount,
    }
    index.set(id, nodes.length)
    nodes.push(node)
    backlinks.set(id, new Set())
    outlinks.set(id, new Set())
    for (const t of n.meta.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
    areaCounts.set(n.meta.area, (areaCounts.get(n.meta.area) ?? 0) + 1)
  }

  // Resolve links + collapse into weighted edges.
  const edgeMap = new Map<string, GraphEdge>()
  const ghostIds = new Set<NoteId>()
  for (const id of ids) {
    const n = notes.get(id)!
    for (const link of n.links) {
      // Always resolve from the raw text so rebuilding after a vault change
      // (a ghost becoming real, a rename) never needs a re-parse.
      const rawTarget = stripRaw(link.raw)
      const target = resolver.resolve(rawTarget)
      if (target) {
        link.to = target
        link.resolved = true
      } else {
        link.resolved = false
        link.to = rawTarget
      }
      if (!link.to || link.to === id) continue
      const to = link.to
      if (!link.resolved) {
        const ghostId = ghostKey(to)
        link.to = ghostId
        let set = unresolved.get(ghostId)
        if (!set) unresolved.set(ghostId, (set = new Set()))
        set.add(id)
        if (!ghosts) continue
        ghostIds.add(ghostId)
      }
      const key = `${id}\u0000${link.to}\u0000${link.kind}`
      const existing = edgeMap.get(key)
      if (existing) existing.weight += 1
      else edgeMap.set(key, { from: id, to: link.to, kind: link.kind, weight: 1 })
    }
  }

  if (ghosts) {
    for (const gid of [...ghostIds].sort()) {
      const refs = unresolved.get(gid)!
      index.set(gid, nodes.length)
      nodes.push({
        id: gid,
        title: gid.replace(/^ghost:/, ''),
        area: 'untagged',
        type: 'note',
        tags: [],
        ghost: true,
        inDegree: refs.size,
        outDegree: 0,
        degree: refs.size,
        created: null,
        updated: null,
        wordCount: 0,
      })
      backlinks.set(gid, new Set(refs))
      outlinks.set(gid, new Set())
    }
  }

  const edges: GraphEdge[] = []
  for (const e of edgeMap.values()) {
    if (!index.has(e.to)) continue
    edges.push(e)
    outlinks.get(e.from)?.add(e.to)
    backlinks.get(e.to)?.add(e.from)
  }

  for (const node of nodes) {
    node.outDegree = outlinks.get(node.id)?.size ?? 0
    node.inDegree = backlinks.get(node.id)?.size ?? 0
    node.degree = node.inDegree + node.outDegree
  }

  const orphans = nodes.filter((n) => !n.ghost && n.degree === 0).map((n) => n.id)

  return { nodes, edges, index, backlinks, outlinks, unresolved, orphans, tagCounts, areaCounts }
}

export function ghostKey(target: string): NoteId {
  return `ghost:${target.trim()}`
}

export function isGhostId(id: NoteId): boolean {
  return id.startsWith('ghost:')
}

export function ghostTitle(id: NoteId): string {
  return id.replace(/^ghost:/, '')
}

function stripRaw(raw: string): string {
  const pipe = raw.indexOf('|')
  const left = pipe >= 0 ? raw.slice(0, pipe) : raw
  const hash = left.indexOf('#')
  return (hash >= 0 ? left.slice(0, hash) : left).trim()
}

/** Links from `id` that point to a ghost — useful for "create this note" affordances. */
export function ghostLinksOf(note: ParsedNote): Link[] {
  return note.links.filter((l) => !l.resolved)
}

/**
 * Find notes whose plain text mentions `title` (or any alias) without linking
 * to it. Case-insensitive whole-word match; excludes the note itself.
 */
export function findUnlinkedMentions(
  notes: Map<NoteId, ParsedNote>,
  graph: GraphData,
  id: NoteId,
): { id: NoteId; excerpt: string }[] {
  const note = notes.get(id)
  if (!note) return []
  const needles = [note.meta.title, ...note.meta.aliases].map((s) => s.trim()).filter((s) => s.length >= 3)
  if (needles.length === 0) return []
  const patterns = needles.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu'))
  const linksTo = graph.backlinks.get(id) ?? new Set<NoteId>()
  const out: { id: NoteId; excerpt: string }[] = []
  for (const other of notes.values()) {
    if (other.meta.id === id || linksTo.has(other.meta.id)) continue
    for (const re of patterns) {
      const m = re.exec(other.plain)
      if (m && m.index !== undefined) {
        const start = Math.max(0, m.index - 60)
        const end = Math.min(other.plain.length, m.index + m[0].length + 60)
        out.push({
          id: other.meta.id,
          excerpt: `${start > 0 ? '…' : ''}${other.plain.slice(start, end)}${end < other.plain.length ? '…' : ''}`,
        })
        break
      }
    }
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Neighbor ids (both directions) within `depth` hops. */
export function neighborhood(graph: GraphData, id: NoteId, depth = 1): Set<NoteId> {
  const seen = new Set<NoteId>([id])
  let frontier = [id]
  for (let d = 0; d < depth; d++) {
    const next: NoteId[] = []
    for (const cur of frontier) {
      for (const n of graph.outlinks.get(cur) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n))
      for (const n of graph.backlinks.get(cur) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n))
    }
    frontier = next
  }
  return seen
}
