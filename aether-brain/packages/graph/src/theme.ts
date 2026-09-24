import type { Area, GraphNode, NoteType } from '@aether/core'
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
}

export const GHOST_COLOR = '#ff3e6c'

export type ColorMode = 'area' | 'type' | 'tag' | 'age'

/** Stable hue per tag (golden-angle walk over a string hash). */
export function tagColor(tag: string): string {
  let h = 2166136261
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const hue = ((h >>> 0) * 137.508) % 360
  return `hsl(${hue.toFixed(0)} 85% 68%)`
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

/** Visual radius in world units. Hubs grow with sqrt(degree); MOCs get a bonus. */
export function nodeRadius(n: GraphNode): number {
  if (n.ghost) return 0.8
  const base = 1.0 + 0.5 * Math.sqrt(n.degree)
  const bonus = n.type === 'moc' ? 1.3 : n.type === 'project' || n.type === 'area' ? 1.1 : 1
  return Math.min(5.5, base * bonus)
}
