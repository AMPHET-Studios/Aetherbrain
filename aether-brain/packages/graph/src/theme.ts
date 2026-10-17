import { isPlanetNode, type Area, type GraphNode, type NoteType } from '@aether/core'
import { Color } from 'three'

/** Cosmic palette. Keep in sync with packages/ui/src/styles.css tokens. */
export const AREA_COLORS: Record<Area, string> = {
  inbox: '#ffb454',
  projects: '#ff5c8a',
  areas: '#4de2ff',
  resources: '#8f7cff',
  archive: '#7c8598',
  untagged: '#9dffb3',
}

export const AREA_LABELS: Record<Area, string> = {
  inbox: 'Inbox',
  projects: 'Projects',
  areas: 'Areas',
  resources: 'Resources',
  archive: 'Archive',
  untagged: 'Untagged',
}

export const AREA_INDEX: Record<Area, number> = {
  inbox: 0,
  projects: 1,
  areas: 2,
  resources: 3,
  archive: 4,
  untagged: 5,
}

export const TYPE_COLORS: Record<NoteType, string> = {
  note: '#cfd6ff',
  daily: '#ffd166',
  person: '#ff8fab',
  project: '#ff5c8a',
  area: '#4de2ff',
  resource: '#8f7cff',
  inbox: '#ffb454',
  concept: '#7cf5c9',
  moc: '#dfe6ff',
  board: '#9fe8d4',
}

export const GHOST_COLOR = '#ff3e6c'

/** A project folder: the biggest, brightest star of the system layout (every folder is a star). */
export const STAR_COLOR = '#ffcf6b'
/** The vault root and its mounts (drives): the galaxies everything orbits. */
export const SUN_COLOR = '#fff1d6'
/** The Today hub: aurora cyan, so it never reads as one of the gold stars. */
export const TODAY_COLOR = '#8ff7ff'
/** Picture moons: a pale moonlight white (the thumbnail is their real color). */
export const IMAGE_COLOR = '#f4f1ff'
/** A reference board with pictures orbiting it: a mint-white sun, cooler than the gold stars and warmer than the Today hub. */
export const BOARD_SUN_COLOR = '#b8f7e2'

/**
 * Planet color for a folder: a stable hashed hue with soft saturation. Hues in
 * the gold band of the stars are skipped so a planet never reads as a star.
 */
export function planetColor(path: string): string {
  let h = 2166136261
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  let hue = (h >>> 0) % 335
  if (hue >= 32) hue += 25
  return `hsl(${hue}, 42%, 62%)`
}

/**
 * Star color for a folder: a stable hue in the warm band (ember to straw), so a star never reads as a planet and
 * two folders still tell apart. A project star is STAR_COLOR.
 */
export function starColor(path: string): string {
  let h = 2166136261
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  const hue = 16 + ((h >>> 0) % 44)
  return `hsl(${hue}, 88%, 66%)`
}

export type ColorMode = 'area' | 'type' | 'tag' | 'age'

/** Stable hue per tag (golden-angle walk over a string hash). */
export function tagColor(tag: string): string {
  let h = 2166136261
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const hue = ((h >>> 0) * 137.508) % 360
  // Comma syntax: three's Color parser does not read the space-separated form (it falls back to white).
  return `hsl(${hue.toFixed(0)}, 85%, 68%)`
}

const _ageA = new Color('#ffe08a')
const _ageB = new Color('#3d5aff')
const _tmp = new Color()

/** Age gradient: warm = recent, cold = old. t in [0,1] where 0 = newest. */
export function ageColor(t: number): Color {
  return _tmp.copy(_ageA).lerp(_ageB, Math.min(1, Math.max(0, t))).clone()
}

const colorCache = new Map<string, Color>()
export function cachedColor(css: string): Color {
  let c = colorCache.get(css)
  if (!c) {
    c = new Color(css)
    colorCache.set(css, c)
  }
  return c
}

export function nodeBaseColor(
  n: GraphNode,
  mode: ColorMode,
  activeTag: string | null,
  ageOf: (n: GraphNode) => number,
): Color {
  // Folders (the structure of the system layout), the Today hub, pictures and board suns ignore the color mode.
  if (n.kind === 'today') return cachedColor(TODAY_COLOR)
  if (n.kind === 'image') return cachedColor(IMAGE_COLOR)
  if (n.board) return cachedColor(BOARD_SUN_COLOR)
  if (n.folder) {
    const role = n.folder.role
    if (role === 'root' || role === 'mount') return cachedColor(SUN_COLOR)
    if (role === 'project') return cachedColor(STAR_COLOR)
    return cachedColor(starColor(n.folder.path))
  }
  if (n.ghost) return cachedColor(GHOST_COLOR)
  switch (mode) {
    case 'type':
      return cachedColor(TYPE_COLORS[n.type])
    case 'tag': {
      if (activeTag) return n.tags.includes(activeTag) ? cachedColor(tagColor(activeTag)) : cachedColor('#4a5170')
      const t = n.tags[0]
      return t ? cachedColor(tagColor(t)) : cachedColor('#4a5170')
    }
    case 'age':
      return ageColor(ageOf(n))
    case 'area':
    default:
      return cachedColor(AREA_COLORS[n.area])
  }
}

/** How big pictures are drawn, named after Windows' icon views (`z` cycles them). */
export type PictureSize = 'medium' | 'large' | 'xl'
export const PICTURE_SIZES: readonly PictureSize[] = ['medium', 'large', 'xl']
/**
 * A picture's radius at each size, in world units (its thumbnail is THUMB_SCALE times as wide): medium is
 * smaller than most planets, large about a big planet, extra large about a star.
 */
export const PICTURE_RADIUS: Record<PictureSize, number> = { medium: 1.4, large: 3.2, xl: 5.5 }
export const PICTURE_SIZE_NAMES: Record<PictureSize, string> = { medium: 'Medium icons', large: 'Large icons', xl: 'Extra large icons' }

export function isPictureSize(v: unknown): v is PictureSize {
  return v === 'medium' || v === 'large' || v === 'xl'
}

/** A small picture's radius (an icon, a sprite): it is a moon, not a planet. */
export const MOON_PICTURE_RADIUS = 1.0

/**
 * Visual radius in world units (docs/COSMOLOGY.md). Galaxies (drives, a one-folder vault) are the biggest bodies; the
 * origin of a multi-root vault is small. Stars grow with what they hold, a project a little more. A planet is
 * a big picture, video or model (the radius of the picture size, extra large by default) or a document-sized note;
 * a moon is every small file. A reference board with pictures orbiting it is a sun: 4 and a little more for each doubling
 * of its pictures, at most 9 (a star holds notes, a sun holds pictures, and must stay in scale with them). The Today hub
 * is a fixed 4.6. The system layout spaces orbits by these radii.
 */
export function nodeRadius(n: GraphNode, pictures: PictureSize = 'medium'): number {
  if (n.kind === 'today') return 4.6
  if (n.kind === 'image') return isPlanetNode(n) ? (PICTURE_RADIUS[pictures] ?? PICTURE_RADIUS.xl) : MOON_PICTURE_RADIUS
  if (n.board) return Math.min(9, 4 + 0.9 * Math.log2(1 + n.board.pictures))
  if (n.folder) {
    const f = n.folder
    if (f.role === 'mount') return 16
    if (f.role === 'root') return f.galaxy ? 16 : 6
    const held = Math.log2(1 + f.totalNotes + f.childFolders + 0.25 * f.images)
    const star = Math.min(8, 3.4 + 0.6 * held)
    return f.role === 'project' ? star + 1.2 : star
  }
  if (n.ghost) return 0.7
  const links = Math.sqrt(n.degree)
  if (isPlanetNode(n)) return Math.min(4.2, 2.4 + 0.3 * links)
  return Math.min(2.0, 0.8 + 0.18 * links)
}
