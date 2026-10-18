import type { Area, FolderRole, FolderSelection, GalleryInfo, GraphData, GraphEdge, GraphNode, ImageNodeInfo, Link, NoteId, ParsedNote, VaultAsset } from '../types'
import { LinkResolver } from './resolve'
import { asString } from '../markdown/frontmatter'
import type { DailyBrief } from '../markdown/brief'
import { isProjectNote, projectFolderOf } from '../markdown/projects'
import { noteUrgency, systemUrgency } from '../markdown/urgency'
import { AssetResolver, TODAY_ID, imageKey, imageTitle, isAssetPath, isImageId, isModelPath, isVideoPath } from '../vault/assets'
import { folderUniverse, selectFolders, type FolderSelectOptions } from '../vault/folders'
import { ancestorsOf, areaFromFolder, folderDepth, folderKey, folderOf, isFolderId, normalizeFolderPath } from '../vault/paths'

export interface FolderGraphOptions extends FolderSelectOptions {
  /** Every folder known on disk (vault paths). */
  all: Iterable<string>
  /** Title of the root node (the vault name). */
  rootTitle: string
  /** Display labels for mounts, e.g. { D: 'D:\\' }. */
  mountLabels?: Record<string, string>
  /**
   * The Bio star's folder as the vault spells it (`Bio`, or `D/Bio` in a vault of several roots; `BIO_FOLDER` under the
   * vault's home). When that folder exists it is always shown, and its node is marked `folder.bio`. A folder that is not
   * there is not made up, and a drive (a mount) is never the Bio star.
   */
  bio?: string | null
}

export interface ImageGraphOptions {
  /** Every image of the vault: vault path → asset (see `assetMap`). */
  all: Map<string, VaultAsset>
  /**
   * With folders (the system layout): the newest images of every shown
   * folder become moons of it. Without it only embedded / linked images get
   * nodes (in every layout).
   */
  moons?: boolean
  /** Most images per folder, newest first (default 24); linked images count toward it and always show. */
  maxPerFolder?: number
  /** Most image nodes in the graph, embedded ones first (default 1500). */
  maxTotal?: number
  /**
   * With folders: the folder of a project star whose gallery is open. Every
   * picture under it (subfolders included, newest first) becomes a card of
   * the gallery: moons and linked pictures keep their node (and their orbit
   * slot), the others get a node of their own parented to the star, up to
   * `maxGallery`. Not a shown project star: no gallery.
   */
  gallery?: string | null
  /** Most cards a gallery adds beyond the pictures already in the graph (default `GALLERY_MAX`). */
  maxGallery?: number
}

/** Pictures a star gallery shows at most (besides moons and linked pictures, which always count). */
export const GALLERY_MAX = 480

export interface TodayGraphOptions {
  /** The brief the hub stands for (`dailyBrief`): its beams go to `brief.noteIds`. */
  brief: DailyBrief
}

export interface BuildGraphOptions {
  /** Include unresolved link targets as ghost nodes (default true). */
  ghosts?: boolean
  /** Build folder nodes + structural parents (system layout). Omit/null for classic graphs. */
  folders?: FolderGraphOptions | null
  /**
   * Picture files: `![[art.png]]` / `[[art.png]]` resolve to image nodes, and
   * with folders + `moons` each shown folder gets its newest pictures as
   * moons. Omit/null: image links resolve to nothing (never ghosts).
   */
  images?: ImageGraphOptions | null
  /** Add the Today hub (id `today:`) with beams to the notes of today's brief. Omit/null: no hub. */
  today?: TodayGraphOptions | null
  /**
   * Give every node its urgency on `date` (YYYY-MM-DD, local time): a note's from its open tasks, a picture's from
   * the notes that embed it, a folder's from everything in its system. Omit/null: no node has one.
   */
  urgency?: { date: string } | null
}

function toTs(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/**
 * Resolve every link across the vault and build the graph.
 * Mutates `note.links[i].to/resolved` in place so the store has resolved links
 * without a second pass. Deterministic node order: notes sorted by id, ghosts
 * sorted by id, linked images sorted by path, then (with `folders`) image
 * moons sorted by path and folder nodes sorted by path, then the Today hub —
 * stable order keeps the worker layout stable across rebuilds.
 *
 * Links whose target is a picture file (`![[gate.png]]`) resolve against
 * `opts.images` (to `image:<path>`, `resolved: true`) or stay unresolved, but
 * never become ghosts: a missing picture is not a note to write.
 */
export function buildGraph(notes: Map<NoteId, ParsedNote>, opts: BuildGraphOptions = {}): GraphData {
  const ghosts = opts.ghosts ?? true
  const resolver = new LinkResolver(notes.values())
  const assets = opts.images?.all ?? null
  // Built on the first picture link only, and kept per asset map (a note edit keeps the map).
  let assetResolver: AssetResolver | null | undefined
  const pictures = (): AssetResolver | null => (assetResolver ??= assets && assets.size ? resolverOf(assets) : null)
  /** Vault paths of the images some note links to or embeds. */
  const linkedImages = new Set<string>()

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
      const rawTarget = link.literal ? link.raw.trim() : stripRaw(link.raw)
      if (isAssetPath(rawTarget)) {
        // A picture, video or 3D model: an image node when the file exists, else nothing (never a ghost).
        const img = pictures()?.resolve(rawTarget, n.meta.folder) ?? null
        link.resolved = img !== null
        link.to = img !== null ? imageKey(img) : rawTarget
        if (img === null) continue
        linkedImages.add(img)
        const key = `${id}\u0000${link.to}\u0000${link.kind}`
        const existing = edgeMap.get(key)
        if (existing) existing.weight += 1
        else edgeMap.set(key, { from: id, to: link.to, kind: link.kind, weight: 1 })
        continue
      }
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

  // Linked images (every layout); moons come with the folder system below.
  const imageBudget = { left: Math.max(0, opts.images?.maxTotal ?? 1500) }
  for (const path of [...linkedImages].sort()) {
    if (imageBudget.left <= 0) break
    imageBudget.left--
    addImageNode(nodes, index, backlinks, outlinks, path, assets?.get(path))
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
    if (node.image) node.image.embeddedBy = node.inDegree
  }

  const orphans = nodes.filter((n) => n.kind === 'note' && n.degree === 0).map((n) => n.id)

  const system = opts.folders
    ? addFolderSystem(notes, ids, nodes, index, unresolved, opts.folders, {
        images: assets,
        moons: !!opts.images?.moons,
        maxPerFolder: opts.images?.maxPerFolder ?? 24,
        budget: imageBudget,
        gallery: opts.images?.gallery ?? null,
        maxGallery: Math.max(0, opts.images?.maxGallery ?? GALLERY_MAX),
        backlinks,
        outlinks,
      })
    : null

  if (opts.today) addTodayHub(nodes, edges, index, backlinks, outlinks, opts.today.brief, opts.folders ? folderKey('') : null)
  if (opts.urgency) applyUrgency(nodes, index, notes, backlinks, opts.urgency.date)

  return {
    nodes,
    edges,
    index,
    backlinks,
    outlinks,
    unresolved,
    orphans,
    tagCounts,
    areaCounts,
    folderSelection: system?.selection ?? null,
    gallery: system?.gallery ?? null,
  }
}

/**
 * Urgency of every node (see `GraphNode.urgency`): notes from their tasks, pictures from the notes that embed them,
 * folders from what is directly in them, deepest folders first so each system is complete before its parent reads it.
 */
function applyUrgency(
  nodes: GraphNode[],
  index: Map<NoteId, number>,
  notes: Map<NoteId, ParsedNote>,
  backlinks: Map<NoteId, Set<NoteId>>,
  date: string,
): void {
  const u = new Float64Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.kind === 'note') {
      const note = notes.get(n.id)
      u[i] = note ? noteUrgency(note, date) : 0
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.kind !== 'image') continue
    let max = 0
    for (const from of backlinks.get(n.id) ?? []) {
      const j = index.get(from)
      if (j !== undefined && u[j]! > max) max = u[j]!
    }
    u[i] = max
  }
  // Folders: everything directly in a folder (files and sub-systems) is read when its depth comes up.
  const kids = new Map<number, number[]>()
  const folders: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.folder) folders.push(i)
    if (n.parent === null) continue
    const p = index.get(n.parent)
    if (p === undefined) continue
    const list = kids.get(p)
    if (list) list.push(i)
    else kids.set(p, [i])
  }
  folders.sort((a, z) => nodes[z]!.folder!.depth - nodes[a]!.folder!.depth)
  for (const f of folders) {
    const list = kids.get(f)
    if (!list) continue
    const values = new Float64Array(list.length)
    for (let k = 0; k < list.length; k++) values[k] = u[list[k]!]!
    u[f] = systemUrgency(values)
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.kind === 'today' || n.kind === 'ghost') continue
    n.urgency = Math.round(u[i]! * 1000) / 1000
  }
}

/** Append an image node (no parent yet; the folder system sets it). */
function addImageNode(
  nodes: GraphNode[],
  index: Map<NoteId, number>,
  backlinks: Map<NoteId, Set<NoteId>>,
  outlinks: Map<NoteId, Set<NoteId>>,
  path: string,
  asset: VaultAsset | undefined,
): GraphNode {
  const id = imageKey(path)
  const mtime = asset?.mtime ?? null
  const image: ImageNodeInfo = { path, mtime, size: asset?.size ?? null, embeddedBy: 0 }
  if (isVideoPath(path)) image.video = true
  else if (isModelPath(path)) image.model = true
  const node: GraphNode = {
    id,
    title: imageTitle(path),
    area: areaFromFolder(path) ?? 'untagged',
    type: 'resource',
    tags: [],
    kind: 'image',
    ghost: false,
    parent: null,
    image,
    inDegree: 0,
    outDegree: 0,
    degree: 0,
    created: mtime,
    updated: mtime,
    wordCount: 0,
  }
  index.set(id, nodes.length)
  nodes.push(node)
  backlinks.set(id, new Set())
  outlinks.set(id, new Set())
  return node
}

/**
 * The Today hub: one node with a beam to every note of the brief. Beams are
 * outlinks of the hub only (a note's backlinks never list the hub, and it
 * never makes a note less of an orphan).
 */
function addTodayHub(
  nodes: GraphNode[],
  edges: GraphEdge[],
  index: Map<NoteId, number>,
  backlinks: Map<NoteId, Set<NoteId>>,
  outlinks: Map<NoteId, Set<NoteId>>,
  brief: DailyBrief,
  parent: NoteId | null,
): void {
  const out = new Set<NoteId>()
  for (const id of brief.noteIds) {
    if (!index.has(id) || out.has(id)) continue
    out.add(id)
    edges.push({ from: TODAY_ID, to: id, kind: 'today', weight: 1 })
  }
  index.set(TODAY_ID, nodes.length)
  nodes.push({
    id: TODAY_ID,
    title: 'Today',
    area: 'inbox',
    type: 'daily',
    tags: [],
    kind: 'today',
    ghost: false,
    parent,
    today: {
      date: brief.date,
      overdue: brief.overdue.length,
      today: brief.today.length,
      next: brief.next.length,
      total: brief.total,
    },
    inDegree: 0,
    outDegree: out.size,
    degree: out.size,
    created: null,
    updated: null,
    wordCount: 0,
  })
  backlinks.set(TODAY_ID, new Set())
  outlinks.set(TODAY_ID, out)
}

/**
 * The picture resolver of an asset map, memoized per map like the folder
 * universe: indexing a whole drive's pictures takes a noticeable moment, and
 * a note edit or a tick keeps the map (applyChanges copies it only when a
 * picture changed).
 */
const resolverCache = new WeakMap<Map<string, VaultAsset>, AssetResolver>()

function resolverOf(assets: Map<string, VaultAsset>): AssetResolver {
  let r = resolverCache.get(assets)
  if (!r) {
    r = new AssetResolver(assets.keys())
    resolverCache.set(assets, r)
  }
  return r
}

/** Images per folder, newest first (then by path), per asset map: memoized like the folder universe. */
const imagesByFolderCache = new WeakMap<Map<string, VaultAsset>, Map<string, string[]>>()

function imagesByFolder(assets: Map<string, VaultAsset>): Map<string, string[]> {
  let out = imagesByFolderCache.get(assets)
  if (out) return out
  out = new Map()
  for (const path of assets.keys()) {
    const f = folderOf(path)
    const list = out.get(f)
    if (list) list.push(path)
    else out.set(f, [path])
  }
  for (const list of out.values()) {
    list.sort((a, b) => (assets.get(b)?.mtime ?? 0) - (assets.get(a)?.mtime ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
  }
  imagesByFolderCache.set(assets, out)
  return out
}

interface FolderImageOptions {
  /** Every image of the vault (null: none known). */
  images: Map<string, VaultAsset> | null
  /** Show the newest images of each shown folder as moons (else linked images only). */
  moons: boolean
  maxPerFolder: number
  /** Image nodes still allowed (shared with the linked images). */
  budget: { left: number }
  /** Folder of the project star whose gallery is open (null: none). */
  gallery: string | null
  /** Most cards the gallery adds. */
  maxGallery: number
  backlinks: Map<NoteId, Set<NoteId>>
  outlinks: Map<NoteId, Set<NoteId>>
}

/** Pictures under `folder` (subfolders included), newest first (then by path), per asset map and folder. */
const galleryCache = new WeakMap<Map<string, VaultAsset>, Map<string, string[]>>()

function galleryImages(assets: Map<string, VaultAsset>, folder: string): string[] {
  let perFolder = galleryCache.get(assets)
  if (!perFolder) galleryCache.set(assets, (perFolder = new Map()))
  let out = perFolder.get(folder)
  if (out) return out
  out = []
  const inside = `${folder}/`
  // One by one: a spread of a folder's list would overflow the stack past ~125k pictures.
  for (const [f, list] of imagesByFolder(assets)) if (f === folder || f.startsWith(inside)) for (const path of list) out.push(path)
  out.sort((a, b) => (assets.get(b)?.mtime ?? 0) - (assets.get(a)?.mtime ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
  perFolder.set(folder, out)
  return out
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
  img: FolderImageOptions,
): { selection: FolderSelection; gallery: GalleryInfo | null } {
  // Folders known on disk: everything listed, every note folder, and their
  // ancestors ('' included). Indexed once per folder Set, not on every rebuild.
  const known = folderUniverse(opts.all, ids.map((id) => notes.get(id)!.meta.folder)).all

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

  // The Bio star: the asked-for folder when the vault has it. Never made up (a pinned folder that is not on disk would be drawn),
  // and a drive is never it.
  const bioAsked = opts.bio ? normalizeFolderPath(opts.bio) : ''
  const bio = bioAsked !== '' && known.has(bioAsked) && !(opts.multiRoot && folderDepth(bioAsked) === 1) ? bioAsked : null

  const selection = selectFolders(
    opts.all,
    ids.map((id) => notes.get(id)!.meta.path),
    {
      multiRoot: opts.multiRoot,
      maxDepth: opts.maxDepth,
      maxFolders: opts.maxFolders,
      // A project star always shows its planets (its direct subfolders), however
      // deep the project folder sits on a drive (F/Lunco/PORTALz is depth 3).
      expanded: [...(opts.expanded ?? []), ...projectAt.keys()],
      pinned: [...(opts.pinned ?? []), ...projectAt.keys(), ...(bio !== null ? [bio] : [])],
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

  // Parents of notes, ghosts and linked images.
  for (const node of nodes) {
    if (node.kind === 'note') {
      const home = homeOf.get(node.id)
      node.parent = folderKey(home ?? nearestVisible(notes.get(node.id)!.meta.folder))
    } else if (node.kind === 'image') {
      node.parent = folderKey(nearestVisible(folderOf(node.image!.path)))
    } else {
      let first: NoteId | null = null
      for (const ref of unresolved.get(node.id) ?? []) if (first === null || ref < first) first = ref
      node.parent = first ?? folderKey('')
    }
  }

  // A reference board is a sun: the pictures on it orbit it, not their folders.
  assignBoardSuns(nodes, index, img.outlinks)

  // Image moons: the newest pictures of every shown folder, shallow folders first.
  const byFolder = img.images ? imagesByFolder(img.images) : null
  const shown = new Map<string, number>()
  for (const node of nodes) {
    // A picture on a board orbits the board: it is not one of its folder's moons.
    if (node.kind !== 'image' || node.parent === null || !isFolderId(node.parent)) continue
    const f = folderPathOfParent(node.parent)
    shown.set(f, (shown.get(f) ?? 0) + 1)
  }
  if (byFolder && img.moons && img.budget.left > 0) {
    const order = [...visible].sort((a, b) => folderDepth(a) - folderDepth(b) || (a < b ? -1 : a > b ? 1 : 0))
    const moons: string[] = []
    for (const f of order) {
      if (img.budget.left <= 0) break
      const list = byFolder.get(f)
      if (!list) continue
      // Linked images of the folder count toward its cap.
      let taken = shown.get(f) ?? 0
      for (const path of list) {
        if (taken >= img.maxPerFolder || img.budget.left <= 0) break
        if (index.has(imageKey(path))) continue
        moons.push(path)
        taken++
        img.budget.left--
      }
    }
    for (const path of moons.sort()) {
      const node = addImageNode(nodes, index, img.backlinks, img.outlinks, path, img.images!.get(path))
      node.parent = folderKey(nearestVisible(folderOf(path)))
      const f = folderPathOfParent(node.parent)
      shown.set(f, (shown.get(f) ?? 0) + 1)
    }
  }

  // The open star gallery: every picture under the star's folder becomes a card, newest first.
  // Pictures already in the graph keep their node and their orbit slot (nothing else moves);
  // the others come in parented to the star, up to the cap.
  let gallery: GalleryInfo | null = null
  const gPath = img.gallery === null ? null : normalizeFolderPath(img.gallery)
  const isStar = gPath !== null && gPath !== '' && !(opts.multiRoot && folderDepth(gPath) === 1) && projectAt.has(gPath)
  if (isStar && img.images && visible.has(gPath)) {
    const star = folderKey(gPath)
    const all = galleryImages(img.images, gPath)
    let cards = 0
    let added = 0
    let videos = 0
    for (const path of all) {
      let node = nodes[index.get(imageKey(path)) ?? -1]
      let only = false
      if (!node) {
        if (added >= img.maxGallery) continue
        node = addImageNode(nodes, index, img.backlinks, img.outlinks, path, img.images.get(path))
        node.parent = star
        only = true
        added++
      }
      if (!node.image) continue
      node.image.gallery = { star, rank: cards++, only }
      if (node.image.video) videos++
    }
    if (cards > 0) gallery = { star, path: gPath, cards, videos, total: all.length }
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
        ...(role === 'root' && !opts.multiRoot ? { galaxy: true } : {}),
        ...(bio !== null && path === bio ? { bio: true } : {}),
        projectId,
        inProject: ancestorsOf(path).some((a) => projectAt.has(a)),
        childFolders: selection.childCount.get(path) ?? 0,
        hiddenFolders: selection.hidden.get(path) ?? 0,
        notes: direct.get(path) ?? 0,
        totalNotes: total.get(path) ?? 0,
        images: byFolder?.get(path)?.length ?? 0,
        shownImages: shown.get(path) ?? 0,
      },
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      created: null,
      updated: null,
      wordCount: 0,
    })
  }
  return { selection, gallery }
}

/**
 * Reference boards are suns (docs/COSMOLOGY.md): every picture or video a board links to orbits that board instead of
 * its own folder, and the board is marked (`GraphNode.board`) so it is drawn as a star and laid out as a system. A
 * picture on several boards orbits the first by id (the others keep their links); a board none of whose pictures is
 * left to it stays a plain note. `nodes` lists notes in id order, so the choice is stable across rebuilds.
 */
function assignBoardSuns(nodes: GraphNode[], index: Map<NoteId, number>, outlinks: Map<NoteId, Set<NoteId>>): void {
  const taken = new Set<NoteId>()
  for (const board of nodes) {
    if (board.kind !== 'note' || board.type !== 'board') continue
    let pictures = 0
    for (const target of [...(outlinks.get(board.id) ?? [])].filter(isImageId).sort()) {
      if (taken.has(target)) continue
      const picture = nodes[index.get(target) ?? -1]
      if (!picture || picture.kind !== 'image') continue
      taken.add(target)
      picture.parent = board.id
      pictures++
    }
    if (pictures > 0) board.board = { pictures }
  }
}

/** Folder path of a parent id (`folder:a/b` → `a/b`). */
function folderPathOfParent(parent: NoteId | null): string {
  return parent === null ? '' : parent.slice('folder:'.length)
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
