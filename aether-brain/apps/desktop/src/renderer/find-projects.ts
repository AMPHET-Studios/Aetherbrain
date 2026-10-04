/**
 * Find projects, the renderer's half: which of the folders main found are
 * offered as new stars, and which are ticked when the panel opens. Pure,
 * unit-tested; FindProjectsPanel shows the rows and makeProjects writes the
 * ticked ones.
 */
import { areaFromFolder } from '@aether/core'
import type { ProjectCandidateDto } from '../shared/ipc'

export interface ProjectRow extends ProjectCandidateDto {
  /** Ticked when the panel opens. */
  ticked: boolean
  /** The found folder or star this one is inside (its name), or null. */
  inside: string | null
}

/** A star the vault already has: its folder (vault path) and its name. */
export interface KnownStar {
  path: string
  name: string
}

/**
 * The rows to offer, shallowest first. Folders that already are stars and
 * archived folders are left out. Ticked: a folder inside no sure project
 * (an engine or code project, a git repository, a star); one found by its
 * creative files alone also needs to be inside no other found folder, so a
 * project's `Art` folder never becomes a second star by default.
 */
export function reviewRows(candidates: readonly ProjectCandidateDto[], stars: readonly KnownStar[]): ProjectRow[] {
  const key = (p: string) => p.toLowerCase()
  const starAt = new Map(stars.map((s) => [key(s.path), s.name]))
  const kept = candidates.filter((c) => !starAt.has(key(c.path)) && areaFromFolder(`${c.path}/x.md`) !== 'archive')
  const found = new Map(kept.map((c) => [key(c.path), c]))
  return kept.map((c) => {
    let inside: string | null = null
    let inSure = false
    let p = c.path
    for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/')) {
      p = p.slice(0, cut)
      const star = starAt.get(key(p))
      const outer = found.get(key(p))
      if (star === undefined && !outer) continue
      inside ??= star ?? outer!.name
      if (star !== undefined || outer!.strong) {
        inSure = true
        break
      }
    }
    return { ...c, inside, ticked: !inSure && (c.strong || inside === null) }
  })
}

/** The paths of the ticked rows. */
export function tickedPaths(rows: readonly ProjectRow[], ticked: ReadonlySet<string>): string[] {
  return rows.filter((r) => ticked.has(r.path)).map((r) => r.path)
}

/** At most this many stars before the hint offers Find projects. */
export const HINT_MAX_STARS = 1
/** At least this many folders in the vault before the hint shows (a tiny vault has nothing to find). */
export const HINT_MIN_FOLDERS = 8

/** True when the vault looks starless enough to offer Find projects once. */
export function wantsHint(stars: number, folders: number): boolean {
  return stars <= HINT_MAX_STARS && folders >= HINT_MIN_FOLDERS
}
