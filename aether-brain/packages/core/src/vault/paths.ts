import type { Area, NoteId, NoteType } from '../types'

/** Normalize any path to vault-relative posix form without leading `./` or `/`. */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
}

export function isMarkdownPath(p: string): boolean {
  return /\.md$/i.test(p)
}

/** Ignore hidden folders, Obsidian config, node_modules etc. */
export function isIgnoredPath(p: string): boolean {
  const parts = normalizePath(p).split('/')
  return parts.some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === '__MACOSX')
}

export function idFromPath(path: string): NoteId {
  return normalizePath(path).replace(/\.md$/i, '')
}

export function pathFromId(id: NoteId): string {
  return `${id}.md`
}

export function folderOf(path: string): string {
  const n = normalizePath(path)
  const i = n.lastIndexOf('/')
  return i < 0 ? '' : n.slice(0, i)
}

export function basenameOf(path: string): string {
  const n = normalizePath(path)
  const i = n.lastIndexOf('/')
  return (i < 0 ? n : n.slice(i + 1)).replace(/\.md$/i, '')
}

export function topFolderOf(path: string): string {
  const n = normalizePath(path)
  const i = n.indexOf('/')
  return i < 0 ? '' : n.slice(0, i)
}

const AREA_FOLDERS: Record<string, Area> = {
  inbox: 'inbox',
  '0 inbox': 'inbox',
  '00 inbox': 'inbox',
  projects: 'projects',
  '1 projects': 'projects',
  '01 projects': 'projects',
  areas: 'areas',
  '2 areas': 'areas',
  '02 areas': 'areas',
  resources: 'resources',
  '3 resources': 'resources',
  '03 resources': 'resources',
  archive: 'archive',
  archives: 'archive',
  '4 archive': 'archive',
  '04 archive': 'archive',
}

export function areaFromFolder(path: string): Area | null {
  const top = topFolderOf(path).toLowerCase()
  return AREA_FOLDERS[top] ?? null
}

export function isArea(v: unknown): v is Area {
  return typeof v === 'string' && ['inbox', 'projects', 'areas', 'resources', 'archive', 'untagged'].includes(v)
}

export function isNoteType(v: unknown): v is NoteType {
  return (
    typeof v === 'string' &&
    ['note', 'daily', 'person', 'project', 'area', 'resource', 'inbox', 'concept', 'moc'].includes(v)
  )
}

const TYPE_FOLDERS: Record<string, NoteType> = {
  daily: 'daily',
  journal: 'daily',
  people: 'person',
  person: 'person',
  maps: 'moc',
  moc: 'moc',
  mocs: 'moc',
  projects: 'project',
  areas: 'area',
  resources: 'resource',
  inbox: 'inbox',
  concepts: 'concept',
}

export function typeFromFolder(path: string): NoteType | null {
  const parts = normalizePath(path).toLowerCase().split('/')
  parts.pop()
  // Nearest folder wins (People/ inside Resources/ still yields 'person').
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]?.replace(/^\d+[\s._-]*/, '') ?? ''
    const t = TYPE_FOLDERS[seg]
    if (t) return t
  }
  return null
}

const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/
export function isDailyName(name: string): boolean {
  return DAILY_RE.test(name)
}

/** Filesystem-safe filename from a title (keeps spaces, drops path separators). */
export function slugifyTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function todayIso(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
