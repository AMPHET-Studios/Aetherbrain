import { describe, expect, it } from 'vitest'
import { folderIndex, matchFolders } from '../src/folderSearch'

/** What the palette did before: rank every folder, sort them all, take the first `limit`. */
function reference(folders: string[], query: string, limit: number): string[] {
  const q = query.trim().toLowerCase()
  const out: { path: string; rank: number }[] = []
  for (const f of folders) {
    const lower = f.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : q.length > 1 && lower.includes(q) ? 3 : -1
    if (rank >= 0) out.push({ path: f, rank })
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((x) => x.path)
}

/** A deterministic drive-like tree. */
function tree(n: number): string[] {
  const words = ['Art', 'Code', 'Content', 'Portal', 'Games', 'Assets', 'con', 'Docs', 'Archive', 'Notes', 'Contracts', 'Icons']
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const out = new Set<string>()
  while (out.size < n) {
    const depth = 1 + Math.floor(rnd() * 5)
    const segs: string[] = []
    for (let d = 0; d < depth; d++) segs.push(`${words[Math.floor(rnd() * words.length)]}${rnd() < 0.5 ? '' : Math.floor(rnd() * 40)}`)
    out.add(segs.join('/'))
  }
  return [...out]
}

describe('folder search', () => {
  const folders = tree(5000)
  const index = folderIndex(folders)

  it('keeps the best few exactly as a full sort would', () => {
    for (const q of ['con', 'Content', 'art', 'portal1', 'rt/co', 'zz', 'a', 'c', 'icons3', 'ts/']) {
      for (const limit of [1, 6, 12]) expect(matchFolders(index, q, limit), `${q} / ${limit}`).toEqual(reference(folders, q, limit))
    }
  })

  it('matches one letter by name only, and nothing for an empty query', () => {
    // `a` is in almost every path: only folder names count for one letter.
    expect(matchFolders(folderIndex(['Art/Sketches', 'Docs/Art', 'Zebra']), 'a', 6)).toEqual(['Docs/Art', 'Zebra'])
    expect(matchFolders(folderIndex(['Art/Sketches', 'Docs/Art', 'Zebra']), 'ar', 6)).toEqual(['Docs/Art', 'Art/Sketches'])
    expect(matchFolders(index, '  ', 6)).toEqual([])
    expect(matchFolders(index, 'con', 0)).toEqual([])
  })
})
