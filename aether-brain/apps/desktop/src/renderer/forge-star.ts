/**
 * Which ★ star of the brain carries the Concept Forge screen. Pure (no store,
 * no bridge), so it is unit-tested in node; forge.ts feeds it the graph and
 * the remembered concept-forge.html.
 *
 * In order: a project called Concept Forge (its folder name, its note's title
 * or an alias, spaces and case aside), the one whose folder holds the page
 * first; else the deepest project star whose folder holds the page; else none
 * (the palette's "Concept Forge — fly to its star" makes one).
 */
import { folderKey, isProjectNote, projectFolderOf, type NoteId, type ParsedNote } from '@aether/core'
import type { VaultRootDto } from '../shared/ipc'

/** A project star as the resolver sees it. */
export interface ForgeStarCandidate {
  /** The star's node id (`folder:<vault path>`). */
  id: NoteId
  /** Vault path of the star's folder. */
  path: string
  /** Its folder name, its project note's title and aliases. */
  names: string[]
}

/** Spaces, dashes and case aside: "Concept Forge", "concept-forge", "ConceptForge". */
export function isForgeName(name: string): boolean {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'conceptforge'
}

/** File names compare without case on Windows and macOS. */
function caseless(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/** `p` with forward slashes and no trailing slash (`F:\` → `F:`, `/` → ``). */
function slashes(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
}

/**
 * The vault path of the folder holding `file` (an absolute path on disk), or
 * null when it is outside every root. In a vault of several roots it starts
 * with the root's mount (`F/Lunco/ConceptForge`); the root itself is ``.
 */
export function forgeDirOf(file: string | null, roots: readonly VaultRootDto[], platform: string): string | null {
  if (!file) return null
  const f = slashes(file)
  const cut = f.lastIndexOf('/')
  if (cut < 0) return null
  const dir = f.slice(0, cut)
  const fold = caseless(platform) ? (s: string) => s.toLowerCase() : (s: string) => s
  let best: { root: string; mount: string } | null = null
  for (const r of roots) {
    const root = slashes(r.path)
    const inside = fold(dir) === fold(root) || fold(dir).startsWith(`${fold(root)}/`)
    if (inside && (!best || root.length > best.root.length)) best = { root, mount: r.mount }
  }
  if (!best) return null
  const rel = dir.length > best.root.length ? dir.slice(best.root.length + 1) : ''
  return best.mount ? (rel ? `${best.mount}/${rel}` : best.mount) : rel
}

/** True when vault folder `dir` is `folder` or inside it. */
function holds(folder: string, dir: string, platform: string): boolean {
  const a = caseless(platform) ? folder.toLowerCase() : folder
  const b = caseless(platform) ? dir.toLowerCase() : dir
  return b === a || b.startsWith(`${a}/`)
}

/** The star that carries the Concept Forge screen (see the top of this file), or null. */
export function forgeStar(stars: readonly ForgeStarCandidate[], forgeDir: string | null, platform: string): NoteId | null {
  const order = (a: ForgeStarCandidate, b: ForgeStarCandidate) => a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const named = stars.filter((s) => s.names.some(isForgeName))
  if (named.length) {
    const home = forgeDir === null ? undefined : named.find((s) => holds(s.path, forgeDir, platform))
    if (home) return home.id
    const byFolder = named.filter((s) => isForgeName(s.path.slice(s.path.lastIndexOf('/') + 1)))
    return [...(byFolder.length ? byFolder : named)].sort(order)[0]?.id ?? null
  }
  if (forgeDir === null) return null
  const holding = stars.filter((s) => s.path !== '' && holds(s.path, forgeDir, platform))
  // The deepest one: the project closest to the page.
  return [...holding].sort((a, b) => order(b, a))[0]?.id ?? null
}

/**
 * The project stars of the vault: each project note's home folder (the one
 * the system layout draws as its ★ star), with the names it goes by. Built
 * from the notes, so it is the same in every layout.
 */
export function projectStars(notes: Iterable<ParsedNote>, folders: ReadonlySet<string>): ForgeStarCandidate[] {
  const known = folders as Set<string>
  const byPath = new Map<string, ForgeStarCandidate>()
  for (const n of notes) {
    if (!isProjectNote(n)) continue
    const path = projectFolderOf(n, known)
    if (!path || !known.has(path)) continue
    let c = byPath.get(path)
    if (!c) {
      c = { id: folderKey(path), path, names: [path.slice(path.lastIndexOf('/') + 1)] }
      byPath.set(path, c)
    }
    c.names.push(n.meta.title, ...n.meta.aliases)
  }
  return [...byPath.values()]
}
