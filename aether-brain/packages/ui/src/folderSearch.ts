/**
 * Folder search for the palette and the board's folder picker. A whole-drive
 * vault has hundreds of thousands of folders, so the lower-cased names are
 * built once per folder Set (`folderIndex`, memoized by the caller) and each
 * keystroke keeps only the best `limit` matches instead of sorting them all.
 */

/** One folder, lower-cased once. */
export interface FolderEntry {
  path: string
  lower: string
  /** Lower-cased last segment. */
  name: string
}

/** Every folder of a Set, ready for `matchFolders`. */
export function folderIndex(folders: Iterable<string>): FolderEntry[] {
  const out: FolderEntry[] = []
  for (const path of folders) {
    const lower = path.toLowerCase()
    out.push({ path, lower, name: lower.slice(lower.lastIndexOf('/') + 1) })
  }
  return out
}

interface Hit {
  path: string
  rank: number
}

/** Better first: lower rank, then shorter path, then by path. */
function compareHits(a: Hit, b: Hit): number {
  return a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path)
}

/**
 * Folders whose name (best) or path contains the query: exact name, then
 * name prefix, then name, then path (the path only for two characters or
 * more: one letter is in nearly every path); shorter paths first. At most
 * `limit`, in order. Linear in the folders, whatever the query.
 */
export function matchFolders(index: readonly FolderEntry[], query: string, limit: number): string[] {
  const q = query.trim().toLowerCase()
  if (!q || limit <= 0) return []
  const best: Hit[] = []
  for (const f of index) {
    let rank = f.name === q ? 0 : f.name.startsWith(q) ? 1 : f.name.includes(q) ? 2 : -1
    const worst = best.length === limit ? best[best.length - 1] : undefined
    if (rank < 0) {
      // A path-only match can't beat a full list of name matches: skip the scan.
      if (q.length < 2 || (worst && worst.rank < 3) || !f.lower.includes(q)) continue
      rank = 3
    }
    const hit = { path: f.path, rank }
    if (worst && compareHits(hit, worst) >= 0) continue
    // Insert in order (the list holds at most `limit` entries).
    let i = best.length
    while (i > 0 && compareHits(hit, best[i - 1]!) < 0) i--
    best.splice(i, 0, hit)
    if (best.length > limit) best.pop()
  }
  return best.map((h) => h.path)
}
