/**
 * Galaxies you mark, and how much a folder holds (docs/COSMOLOGY.md, "A galaxy is a folder you mark" and "A star grows with what it holds").
 *
 * A project folder is a star. Put `scale: galaxy` in its project note and it is a galaxy instead: a disc of its own, with its sub-folders
 * lying on it as stars. A galaxy sits on the galaxy above it, however deep its folder is (the folders in between stay stars), nests at most
 * `GALAXY_MAX_LEVELS` deep counting the vault (or a drive) as level 1, and at most `GALAXY_MAX_MARKS` of them count in a vault: a mark
 * beyond that is kept and told about, and its folder stays a star.
 *
 * Everything here is pure: paths in, plans and numbers out. `build.ts` puts it to use.
 */
import type { FolderData, Frontmatter, GalaxyMarkIgnored } from '../types'
import { asString } from '../markdown/frontmatter'
import { folderDepth, folderOf } from '../vault/paths'

/** A vault (or a drive) is level 1; a galaxy you mark sits on level 2, and one inside it on level 3. A deeper mark is ignored. */
export const GALAXY_MAX_LEVELS = 3
/** Most marks that count in one vault; the rest are ignored, so a vault of thousands of project folders cannot grow the sky without bound. */
export const GALAXY_MAX_MARKS = 64

export type FolderScale = 'star' | 'galaxy'

/** The `scale:` of a project note: `galaxy` (any letter case) makes its folder a galaxy; anything else, or nothing, leaves it a star. */
export function scaleOf(frontmatter: Frontmatter): FolderScale {
  return asString(frontmatter['scale'])?.trim().toLowerCase() === 'galaxy' ? 'galaxy' : 'star'
}

export interface GalaxyPlan {
  /** The marks that count, by folder path: the level they sit on and the galaxy they are placed on (a vault, a drive or another marked galaxy). */
  galaxies: Map<string, { level: number; onto: string }>
  /** The marks that do not count, and why. */
  ignored: Map<string, GalaxyMarkIgnored>
}

/**
 * Which marked folders are galaxies. `marked` is every project folder whose note says `scale: galaxy`; `multiRoot` says the vault is
 * several drives (a drive is a galaxy and the vault is only their origin) rather than one folder (the vault is the galaxy).
 *
 * Settled shallowest first, then by path, so the same vault always gives the same answer and a galaxy is settled before the galaxies
 * inside it. A mark that does not count leaves its folder a star, and does not stop the galaxies inside it from counting.
 */
export function planGalaxies(marked: Iterable<string>, multiRoot: boolean): GalaxyPlan {
  const galaxies = new Map<string, { level: number; onto: string }>()
  const ignored = new Map<string, GalaxyMarkIgnored>()
  const paths = [...new Set(marked)].sort((a, b) => folderDepth(a) - folderDepth(b) || (a < b ? -1 : a > b ? 1 : 0))
  for (const path of paths) {
    // The vault itself, and a drive of a vault of several, are galaxies already.
    if (path === '' || (multiRoot && folderDepth(path) === 1)) {
      ignored.set(path, 'drive')
      continue
    }
    let onto = ''
    let level = 1
    for (let cur = folderOf(path); ; cur = folderOf(cur)) {
      const g = galaxies.get(cur)
      if (g) {
        onto = cur
        level = g.level
        break
      }
      if (multiRoot ? folderDepth(cur) <= 1 : cur === '') {
        onto = cur
        level = 1
        break
      }
    }
    level += 1
    if (level > GALAXY_MAX_LEVELS) ignored.set(path, 'depth')
    else if (galaxies.size >= GALAXY_MAX_MARKS) ignored.set(path, 'count')
    else galaxies.set(path, { level, onto })
  }
  return { galaxies, ignored }
}

export const EMPTY_FOLDER_DATA: Readonly<FolderData> = Object.freeze({ notes: 0, words: 0, pictures: 0, videos: 0, models: 0 })

/**
 * What a folder holds in note-equivalents, the one number its size grows with: its notes, its sub-folders, a note's worth for every
 * thousand words, a quarter for each picture and a half for each video or 3D model. Finite and never negative, whatever it is given.
 */
export function dataWeight(data: Readonly<FolderData>, folders: number): number {
  const part = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  return part(data.notes) + part(folders) + part(data.words) / 1000 + 0.25 * part(data.pictures) + 0.5 * (part(data.videos) + part(data.models))
}

/**
 * What each folder holds once the galaxies are taken out of the stars above them. `rolled` is what every folder holds, folders inside
 * it included. A galaxy that sits on another galaxy takes what it holds with it: the folders between it and the galaxy it sits on no
 * longer count it (the galaxies above them have already lost it with theirs). Returns new numbers; `rolled` is not changed.
 */
export function shedGalaxies(rolled: ReadonlyMap<string, Readonly<FolderData>>, plan: GalaxyPlan): Map<string, FolderData> {
  const out = new Map<string, FolderData>()
  for (const [path, d] of rolled) out.set(path, { ...d })
  for (const [path, { onto }] of plan.galaxies) {
    const held = rolled.get(path)
    if (!held) continue
    for (let cur = folderOf(path); ; cur = folderOf(cur)) {
      const d = out.get(cur)
      if (d) {
        d.notes = Math.max(0, d.notes - held.notes)
        d.words = Math.max(0, d.words - held.words)
        d.pictures = Math.max(0, d.pictures - held.pictures)
        d.videos = Math.max(0, d.videos - held.videos)
        d.models = Math.max(0, d.models - held.models)
      }
      if (cur === onto || cur === '') break
    }
  }
  return out
}

/** How many galaxies sit directly under each folder's path (they are folders of it on disk, but not stars of it any more): by parent path. */
export function galaxyChildren(plan: GalaxyPlan): Map<string, number> {
  const out = new Map<string, number>()
  for (const path of plan.galaxies.keys()) {
    const parent = folderOf(path)
    out.set(parent, (out.get(parent) ?? 0) + 1)
  }
  return out
}

/**
 * The galaxies strictly inside `folder` on disk (`galaxyPaths` are the folders of the marks that count). A galaxy takes what it holds
 * with it, so a star's gallery and its picture count leave their pictures to the galaxy (its cards could not float round a star that
 * is no longer their structural parent). A galaxy's own gallery leaves out the galaxies inside it, not itself.
 */
export function galaxiesInside(galaxyPaths: Iterable<string>, folder: string): string[] {
  const inside = `${folder}/`
  const out: string[] = []
  for (const g of galaxyPaths) if (g !== folder && g.startsWith(inside)) out.push(g)
  return out
}

/** True when `path` (a file) lies under one of the `folders`. */
export function underAny(path: string, folders: readonly string[]): boolean {
  for (const f of folders) if (path.startsWith(`${f}/`)) return true
  return false
}
