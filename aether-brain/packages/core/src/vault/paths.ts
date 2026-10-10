import type { Area, NoteId, NoteType, VaultRootInfo } from '../types'

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

/** Ignore hidden folders, Obsidian config, node_modules, repo boilerplate etc. */
export function isIgnoredPath(p: string): boolean {
  const parts = normalizePath(p).split('/')
  return parts.some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === '__MACOSX') || isBoilerplateMarkdown(p)
}

const BOILERPLATE = new Set([
  'LICENSE.md',
  'LICENCE.md',
  'CHANGELOG.md',
  'CHANGES.md',
  'HISTORY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'AUTHORS.md',
  'NOTICE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'ISSUE_TEMPLATE.md',
])

/**
 * Repository boilerplate that is markdown but never a note (exact,
 * case-sensitive basenames such as `LICENSE.md` or `CHANGELOG.md`). Whole
 * drives are full of cloned repos; these would otherwise flood the brain.
 */
export function isBoilerplateMarkdown(path: string): boolean {
  const n = normalizePath(path)
  return BOILERPLATE.has(n.slice(n.lastIndexOf('/') + 1))
}

/** Normalize a folder path: vault-relative posix, no leading or trailing slash ('' = vault root). */
export function normalizeFolderPath(p: string): string {
  return normalizePath(p).replace(/\/+$/, '')
}

/** Graph node id of a folder: `folder:<vault path>`, `folder:` for the vault root. */
export function folderKey(path: string): NoteId {
  return `folder:${normalizeFolderPath(path)}`
}

export function isFolderId(id: NoteId): boolean {
  return id.startsWith('folder:')
}

/** Vault path of a folder node id (inverse of `folderKey`). */
export function folderPathOf(id: NoteId): string {
  return isFolderId(id) ? id.slice('folder:'.length) : id
}

/** Proper ancestors of a vault path, outermost first: 'a/b/c' → ['a', 'a/b'] (never ''). */
export function ancestorsOf(path: string): string[] {
  const parts = normalizeFolderPath(path).split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/** Folder depth: '' → 0, 'a' → 1, 'a/b' → 2. */
export function folderDepth(path: string): number {
  const n = normalizeFolderPath(path)
  return n === '' ? 0 : n.split('/').length
}

/** Mount (first segment) of a vault path in a multi-root vault; '' for single-root vaults. */
export function mountOf(path: string, roots?: VaultRootInfo[] | null): string {
  if (!roots || roots.length < 2) return ''
  return topFolderOf(path) || normalizeFolderPath(path)
}

/** Where new notes go: '' for a single root, `<first mount>/` when the vault has several roots. */
export function homePrefix(roots?: VaultRootInfo[] | null): string {
  const first = roots && roots.length > 1 ? roots[0] : undefined
  return first ? `${first.mount}/` : ''
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

/** PARA area a folder *name* stands for (`Projects`, `1 Projects`, `Archive` …), else null. */
export function areaOfFolderName(name: string): Area | null {
  // Own keys only: a folder named `constructor` must not hit Object.prototype.
  const key = name.toLowerCase()
  return Object.hasOwn(AREA_FOLDERS, key) ? (AREA_FOLDERS[key] ?? null) : null
}

/**
 * PARA area of a file path from its folders: the first of the first two
 * folder segments that is a PARA folder name wins, so `Projects/x.md` and
 * `D/Projects/x.md` (a drive in a multi-root vault) are both in Projects.
 * Deeper segments never count (`a/b/Projects/x.md` has no area).
 */
export function areaFromFolder(path: string): Area | null {
  const folders = folderOf(path).split('/')
  for (const seg of folders.slice(0, 2)) {
    const area = areaOfFolderName(seg)
    if (area) return area
  }
  return null
}

export function isArea(v: unknown): v is Area {
  return typeof v === 'string' && ['inbox', 'projects', 'areas', 'resources', 'archive', 'untagged'].includes(v)
}

export function isNoteType(v: unknown): v is NoteType {
  return (
    typeof v === 'string' &&
    ['note', 'daily', 'person', 'project', 'area', 'resource', 'inbox', 'concept', 'moc', 'board'].includes(v)
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
    const t = Object.hasOwn(TYPE_FOLDERS, seg) ? TYPE_FOLDERS[seg] : undefined
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
