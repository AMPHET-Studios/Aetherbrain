/**
 * Which folders become nodes in the solar-system graph.
 *
 * A whole drive can hold hundreds of thousands of folders, so only a useful
 * slice is shown: everything that holds notes, the project folders, whatever
 * the user expanded, and a shallow breadth-first sweep of the rest.
 */
import type { FolderSelection } from '../types'
import { folderDepth, folderOf, normalizeFolderPath } from './paths'

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

/**
 * Pick the visible folders.
 *
 * Universe: `all` ∪ every note's folder ∪ `pinned`, each with its ancestors.
 * Must-show: the root; in multi-root every mount; every note's folder chain;
 * pinned folders; direct children of expanded folders (each with ancestors).
 * Optional: the remaining folders with depth ≤ maxDepth, breadth-first,
 * alphabetical within a depth, until `maxFolders` were added (the rest are
 * counted in `dropped`). Parents always come before their children, so the
 * visible set is closed under ancestors.
 */
export function selectFolders(all: Iterable<string>, notePaths: Iterable<string>, opts: FolderSelectOptions): FolderSelection {
  const maxDepth = opts.maxDepth ?? 3
  const maxFolders = opts.maxFolders ?? 1500

  const universe = new Set<string>([''])
  // Every folder in the universe has its ancestors in it too, so a chain walk
  // can stop at the first folder it already knows.
  const addChain = (path: string): void => {
    let cur = path
    while (!universe.has(cur)) {
      universe.add(cur)
      cur = folderOf(cur)
    }
  }
  for (const f of all) addChain(normalizeFolderPath(f))
  const noteFolders = new Set<string>()
  for (const p of notePaths) noteFolders.add(folderOf(p))
  for (const f of noteFolders) addChain(f)
  const pinned = [...(opts.pinned ?? [])].map(normalizeFolderPath)
  for (const f of pinned) addChain(f)

  const sorted = [...universe].sort()
  const children = new Map<string, string[]>()
  const childCount = new Map<string, number>()
  for (const f of sorted) childCount.set(f, 0)
  for (const f of sorted) {
    if (f === '') continue
    const parent = folderOf(f)
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
    const list = children.get(parent)
    if (list) list.push(f)
    else children.set(parent, [f])
  }

  const visible = new Set<string>([''])
  const show = (path: string): void => {
    let cur = path
    while (!visible.has(cur)) {
      visible.add(cur)
      cur = folderOf(cur)
    }
  }
  if (opts.multiRoot) for (const mount of children.get('') ?? []) show(mount)
  for (const f of noteFolders) show(f)
  for (const f of pinned) show(f)
  for (const e of opts.expanded ?? []) for (const c of children.get(normalizeFolderPath(e)) ?? []) show(c)

  // Optional folders, breadth-first: bucket by depth, alphabetical inside a bucket.
  const byDepth: string[][] = []
  for (const f of sorted) {
    if (visible.has(f)) continue
    const d = folderDepth(f)
    if (d > maxDepth) continue
    const bucket = byDepth[d]
    if (bucket) bucket.push(f)
    else byDepth[d] = [f]
  }
  let added = 0
  let dropped = 0
  for (const bucket of byDepth) {
    for (const f of bucket ?? []) {
      if (added < maxFolders) {
        visible.add(f)
        added++
      } else dropped++
    }
  }

  const visibleChildren = new Map<string, number>()
  for (const f of visible) {
    if (f === '') continue
    const parent = folderOf(f)
    visibleChildren.set(parent, (visibleChildren.get(parent) ?? 0) + 1)
  }
  const ordered = new Set<string>()
  const hidden = new Map<string, number>()
  for (const f of sorted) {
    if (!visible.has(f)) continue
    ordered.add(f)
    hidden.set(f, (childCount.get(f) ?? 0) - (visibleChildren.get(f) ?? 0))
  }
  return { visible: ordered, childCount, hidden, dropped }
}
