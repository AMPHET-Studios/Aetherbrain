import type { Area, FolderRole, FolderSelection, GraphData, GraphEdge, GraphNode, Link, NoteId, ParsedNote } from '../types'
import { LinkResolver } from './resolve'
import { asString } from '../markdown/frontmatter'
import { isProjectNote, projectFolderOf } from '../markdown/projects'
import { selectFolders, type FolderSelectOptions } from '../vault/folders'
import { ancestorsOf, areaFromFolder, folderDepth, folderKey, folderOf, normalizeFolderPath } from '../vault/paths'

export interface FolderGraphOptions extends FolderSelectOptions {
  /** Every folder known on disk (vault paths). */
  all: Iterable<string>
  /** Title of the root node (the vault name). */
  rootTitle: string
  /** Display labels for mounts, e.g. { D: 'D:\\' }. */
  mountLabels?: Record<string, string>
}

export interface BuildGraphOptions {
  /** Include unresolved link targets as ghost nodes (default true). */
  ghosts?: boolean
  /** Build folder nodes + structural parents (system layout). Omit/null for classic graphs. */
  folders?: FolderGraphOptions | null
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
 * ghosts sorted by id, then (with `folders`) folder nodes sorted by path —
 * stable order keeps the worker layout stable across rebuilds.
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
      kind: 'note',
      ghost: false,
      parent: null,
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
        kind: 'ghost',
        ghost: true,
        parent: null,
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

  const orphans = nodes.filter((n) => n.kind === 'note' && n.degree === 0).map((n) => n.id)

  const folderSelection = opts.folders ? addFolderSystem(notes, ids, nodes, index, unresolved, opts.folders) : null

  return { nodes, edges, index, backlinks, outlinks, unresolved, orphans, tagCounts, areaCounts, folderSelection }
}

/**
 * Append folder nodes and set every node's structural parent (the system
 * layout). Folder nodes are pure structure: no edges, backlinks, outlinks,
 * tag/area counts or orphans.
 */
function addFolderSystem(
  notes: Map<NoteId, ParsedNote>,
  ids: NoteId[],
  nodes: GraphNode[],
  index: Map<NoteId, number>,
  unresolved: Map<NoteId, Set<NoteId>>,
  opts: FolderGraphOptions,
): FolderSelection {
  // Folders known on disk: everything listed, every note folder, and their ancestors.
  const known = new Set<string>()
  const addChain = (path: string): void => {
    let cur = path
    while (cur !== '' && !known.has(cur)) {
      known.add(cur)
      cur = folderOf(cur)
    }
  }
  for (const f of opts.all) addChain(normalizeFolderPath(f))
  for (const id of ids) addChain(notes.get(id)!.meta.folder)

  // Bind project notes to their home folders. A folder takes one project:
  // an explicit `folder:` beats a folder note, which beats a sibling note;
  // ties go to the first id. Folders that don't exist yet are not drawn.
  const candidates: { id: NoteId; folder: string; rank: number }[] = []
  for (const id of ids) {
    const n = notes.get(id)!
    if (!isProjectNote(n)) continue
    const folder = projectFolderOf(n, known)
    if (!folder || !known.has(folder)) continue
    const explicit = normalizeFolderPath(asString(n.frontmatter['folder']) ?? '') !== ''
    candidates.push({ id, folder, rank: explicit ? 0 : folder === n.meta.folder ? 1 : 2 })
  }
  candidates.sort((a, b) => a.rank - b.rank)
  const projectAt = new Map<string, NoteId>()
  const homeOf = new Map<NoteId, string>()
  for (const c of candidates) {
    if (projectAt.has(c.folder)) continue
    projectAt.set(c.folder, c.id)
    homeOf.set(c.id, c.folder)
  }

  const selection = selectFolders(
    known,
    ids.map((id) => notes.get(id)!.meta.path),
    {
      multiRoot: opts.multiRoot,
      maxDepth: opts.maxDepth,
      maxFolders: opts.maxFolders,
      expanded: opts.expanded,
      pinned: [...(opts.pinned ?? []), ...projectAt.keys()],
    },
  )
  const visible = selection.visible
  const nearestVisible = (path: string): string => {
    let cur = path
    while (!visible.has(cur)) cur = folderOf(cur)
    return cur
  }

  const direct = new Map<string, number>()
  const total = new Map<string, number>()
  for (const id of ids) {
    const folder = notes.get(id)!.meta.folder
    direct.set(folder, (direct.get(folder) ?? 0) + 1)
    for (let cur = folder; ; cur = folderOf(cur)) {
      total.set(cur, (total.get(cur) ?? 0) + 1)
      if (cur === '') break
    }
  }

  // Parents of notes and ghosts.
  for (const node of nodes) {
    if (node.kind === 'note') {
      const home = homeOf.get(node.id)
      node.parent = folderKey(home ?? nearestVisible(notes.get(node.id)!.meta.folder))
    } else {
      let first: NoteId | null = null
      for (const ref of unresolved.get(node.id) ?? []) if (first === null || ref < first) first = ref
      node.parent = first ?? folderKey('')
    }
  }

  for (const path of visible) {
    const depth = folderDepth(path)
    const projectId = projectAt.get(path) ?? null
    const role: FolderRole = path === '' ? 'root' : opts.multiRoot && depth === 1 ? 'mount' : projectId ? 'project' : 'folder'
    const labels = opts.mountLabels
    const title =
      role === 'root'
        ? opts.rootTitle
        : role === 'mount'
          ? ((labels && Object.hasOwn(labels, path) ? labels[path] : undefined) ?? path)
          : path.slice(path.lastIndexOf('/') + 1)
    const area: Area = projectId ? 'projects' : (areaFromFolder(`${path}/x`) ?? 'untagged')
    const id = folderKey(path)
    index.set(id, nodes.length)
    nodes.push({
      id,
      title,
      area,
      type: projectId ? 'project' : 'moc',
      tags: [],
      kind: 'folder',
      ghost: false,
      parent: path === '' ? null : folderKey(nearestVisible(folderOf(path))),
      folder: {
        path,
        role,
        depth,
        projectId,
        inProject: ancestorsOf(path).some((a) => projectAt.has(a)),
        childFolders: selection.childCount.get(path) ?? 0,
        hiddenFolders: selection.hidden.get(path) ?? 0,
        notes: direct.get(path) ?? 0,
        totalNotes: total.get(path) ?? 0,
      },
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      created: null,
      updated: null,
      wordCount: 0,
    })
  }
  return selection
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
