/**
 * Which folders become nodes in the solar-system graph.
 *
 * A whole drive can hold hundreds of thousands of folders, so only a useful
 * slice is shown: the folders that hold notes (down to the depth shown), the
 * project folders, whatever the user expanded, and a shallow breadth-first
 * sweep of the rest.
 */
import type { FolderSelection } from '../types'
import { folderOf, normalizeFolderPath } from './paths'

export interface FolderSelectOptions {
  multiRoot: boolean
  /** Deepest folder level shown without expanding (root = 0, mounts = 1 in multi-root). Default 3. */
  maxDepth?: number
  /** Cap on optional (depth-based) folders. Must-show folders are never dropped. Default 1500. */
  maxFolders?: number
  /** Folders whose direct children are always shown. */
  expanded?: Iterable<string>
  /** Folders that must be shown (e.g. project folders); their ancestors too. */
  pinned?: Iterable<string>
}

/** Parent of a normalized folder path ('a/b' → 'a', 'a' → ''). */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Depth of a normalized folder path ('' → 0, 'a/b' → 2). */
function depthOf(path: string): number {
  if (path === '') return 0
  let d = 1
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) d++
  return d
}

/** The ancestor of a normalized folder path at `depth` (the path itself when it is not deeper). */
function ancestorAtDepth(path: string, depth: number): string {
  if (depth <= 0) return ''
  let i = -1
  for (let d = 0; d < depth; d++) {
    i = path.indexOf('/', i + 1)
    if (i < 0) return path
  }
  return path.slice(0, i)
}

/**
 * Every folder of a vault, indexed for `selectFolders`. Shared between calls
 * (see `folderUniverse`): never mutate it.
 */
export interface FolderUniverse {
  /** Every folder with all its ancestors, the root '' included (normalized vault paths). */
  all: Set<string>
  /** Direct subfolder count per folder ('' included). */
  childCount: Map<string, number>
  /** Direct subfolders per folder, sorted (only folders that have some). */
  children: Map<string, string[]>
  /** Folders per depth, each list sorted ('' alone at depth 0). */
  byDepth: string[][]
}

function buildUniverse(sources: Iterable<string>[], normalized: boolean): FolderUniverse {
  const all = new Set<string>([''])
  for (const source of sources) {
    for (const f of source) {
      // Every folder in `all` has its ancestors in it too, so a chain walk
      // can stop at the first folder it already knows.
      for (let cur = normalized ? f : normalizeFolderPath(f); !all.has(cur); cur = parentOf(cur)) all.add(cur)
    }
  }
  const sorted = [...all].sort()
  const childCount = new Map<string, number>()
  const children = new Map<string, string[]>()
  const byDepth: string[][] = []
  for (const f of sorted) {
    childCount.set(f, 0)
    const d = depthOf(f)
    const bucket = byDepth[d]
    if (bucket) bucket.push(f)
    else byDepth[d] = [f]
    if (f === '') continue
    const parent = parentOf(f)
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
    const list = children.get(parent)
    if (list) list.push(f)
    else children.set(parent, [f])
  }
  return { all, childCount, children, byDepth }
}

interface UniverseMemo {
  /** Size of the folder Set when the universe was built: a changed size means it was mutated. */
  size: number
  base: FolderUniverse
  /** The last universe widened by folders missing from the Set (note folders, pins), keyed by those folders. */
  extra: { key: string; universe: FolderUniverse } | null
}

const universes = new WeakMap<Set<string>, UniverseMemo>()

/**
 * The folder universe of `all` plus `extra` (each folder with its ancestors).
 *
 * Memoized per `all` Set: a whole drive holds hundreds of thousands of
 * folders, and sorting and indexing them on every save froze the window for
 * a second. The store keeps one folder Set for as long as no folder is added
 * or removed (`applyChanges` copies it on write), so saving a note, a
 * watcher batch, expanding a folder or changing the depth all reuse the
 * index. A Set passed here must not be mutated afterwards (a changed size is
 * noticed and rebuilds, a swap of equal size is not). Other iterables are
 * indexed on every call.
 */
export function folderUniverse(all: Iterable<string>, extra: Iterable<string> = []): FolderUniverse {
  let memo = all instanceof Set ? universes.get(all) : undefined
  if (!memo || memo.size !== (all as Set<string>).size) {
    memo = { size: all instanceof Set ? all.size : 0, base: buildUniverse([all], false), extra: null }
    if (all instanceof Set) universes.set(all, memo)
  }
  const base = memo.base
  const missing = new Set<string>()
  for (const f of extra) {
    if (base.all.has(f)) continue
    const n = normalizeFolderPath(f)
    if (!base.all.has(n)) missing.add(n)
  }
  if (missing.size === 0) return base
  const key = [...missing].sort().join('\n')
  if (memo.extra?.key === key) return memo.extra.universe
  const universe = buildUniverse([base.all, missing], true)
  memo.extra = { key, universe }
  return universe
}

/**
 * Pick the visible folders.
 *
 * Universe: `all` ∪ every note's folder ∪ `pinned`, each with its ancestors
 * (indexed once per folder Set, see `folderUniverse`).
 * Must-show: the root; in multi-root every mount; every note's folder chain
 * down to `maxDepth` (a deeper note orbits its nearest visible ancestor, so
 * one README deep in a drive can't drag a long chain of folders in, each
 * level doubling the size of the solar system); pinned folders; direct
 * children of expanded folders (each with ancestors).
 * Optional: the remaining folders with depth ≤ maxDepth, breadth-first,
 * alphabetical within a depth, until `maxFolders` were added (the rest are
 * counted in `dropped`). Parents always come before their children, so the
 * visible set is closed under ancestors. `childCount` is shared with other
 * selections of the same folder Set: don't mutate it.
 */
export function selectFolders(all: Iterable<string>, notePaths: Iterable<string>, opts: FolderSelectOptions): FolderSelection {
  const maxDepth = opts.maxDepth ?? 3
  const maxFolders = opts.maxFolders ?? 1500

  const noteFolders = new Set<string>()
  for (const p of notePaths) noteFolders.add(folderOf(p))
  const pinned = [...(opts.pinned ?? [])].map(normalizeFolderPath)
  const universe = folderUniverse(all, [...noteFolders, ...pinned])

  const visible = new Set<string>([''])
  const show = (path: string): void => {
    for (let cur = path; !visible.has(cur); cur = parentOf(cur)) visible.add(cur)
  }
  if (opts.multiRoot) for (const mount of universe.children.get('') ?? []) show(mount)
  for (const f of noteFolders) show(ancestorAtDepth(f, maxDepth))
  for (const f of pinned) show(f)
  for (const e of opts.expanded ?? []) for (const c of universe.children.get(normalizeFolderPath(e)) ?? []) show(c)

  // Optional folders, breadth-first: by depth, alphabetical inside a depth.
  const depths = Math.min(maxDepth, universe.byDepth.length - 1)
  let added = 0
  for (let d = 0; d <= depths && added < maxFolders; d++) {
    for (const f of universe.byDepth[d] ?? []) {
      if (added >= maxFolders) break
      if (visible.has(f)) continue
      visible.add(f)
      added++
    }
  }
  // Dropped: folders within maxDepth that are still not visible.
  let within = 0
  for (let d = 0; d <= depths; d++) within += universe.byDepth[d]?.length ?? 0
  let visibleWithin = 0
  for (const f of visible) if (depthOf(f) <= maxDepth) visibleWithin++

  const visibleChildren = new Map<string, number>()
  for (const f of visible) {
    if (f === '') continue
    const parent = parentOf(f)
    visibleChildren.set(parent, (visibleChildren.get(parent) ?? 0) + 1)
  }
  // Path order, as a sort of the whole universe would give (only the visible ones are sorted).
  const ordered = [...visible].sort()
  const hidden = new Map<string, number>()
  for (const f of ordered) hidden.set(f, (universe.childCount.get(f) ?? 0) - (visibleChildren.get(f) ?? 0))
  return { visible: new Set(ordered), childCount: universe.childCount, hidden, dropped: within - visibleWithin }
}
