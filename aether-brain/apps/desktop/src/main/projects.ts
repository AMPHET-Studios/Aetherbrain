/**
 * Find projects: which folders of the vault are the user's own projects (an
 * Unreal or Unity project, a git repository, a folder of Blender or ZBrush
 * files …), so they can become ★ stars in one go. A star is a project note in
 * its folder (`makeProject` writes it, after the user ticks it); nothing here
 * writes anything.
 *
 * Only folders the brain already shows are looked at (the vault's last
 * scan; each is checked against its skip rules again here), one directory
 * listing each: names only, no file is opened.
 *
 * Pure Node (no electron import), unit-tested.
 */
import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import type { ProjectCandidateDto } from '../shared/ipc.js'
import { within } from './fsvault.js'

/** At most this many folders are looked into per run. */
export const MAX_FINDER_FOLDERS = 50_000
/** A folder whose listing takes longer (a sleeping network drive) counts as empty. */
const LIST_TIMEOUT_MS = 3000
/** Folders listed at once. */
const CONCURRENCY = 16
/** Creative files that make a folder a project, by extension: what made them. */
const CREATIVE: Record<string, string> = {
  blend: 'Blender',
  ztl: 'ZBrush',
  zpr: 'ZBrush',
  spp: 'Substance Painter',
  sbs: 'Substance Designer',
  psd: 'Photoshop',
  psb: 'Photoshop',
  kra: 'Krita',
  clip: 'Clip Studio',
  procreate: 'Procreate',
  ma: 'Maya',
  mb: 'Maya',
  max: '3ds Max',
  c4d: 'Cinema 4D',
  hip: 'Houdini',
  hiplc: 'Houdini',
  hipnc: 'Houdini',
  aep: 'After Effects',
  prproj: 'Premiere',
  afphoto: 'Affinity Photo',
  afdesign: 'Affinity Designer',
  xcf: 'GIMP',
}
/** Code projects, by a file at their top. */
const CODE_FILES: ReadonlySet<string> = new Set(['package.json', 'cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle'])
/** Creative files a folder needs to count (one stray .psd in a folder makes no project). */
export const MIN_CREATIVE_FILES = 2
/**
 * Folders that hold everything and are no project, whatever is in them (Windows' and macOS's own user
 * folders, sync roots). Their subfolders still count.
 */
const CONTAINERS: ReadonlySet<string> = new Set([
  'downloads',
  'desktop',
  'documents',
  'my documents',
  'pictures',
  'my pictures',
  'videos',
  'my videos',
  'movies',
  'music',
  'onedrive',
  'dropbox',
  'google drive',
  'icloud drive',
  'users',
  'home',
  'public',
  'temp',
  'tmp',
])

export interface FolderEntry {
  name: string
  dir: boolean
}

export interface ProjectKind {
  /** What it is, for people: `Unreal project`, `git repository`, `Blender files` … */
  kind: string
  /** A project for sure (an engine or code project, a git repository); creative files alone are a guess. */
  strong: boolean
  /** How many creative files it holds directly (0 for the sure kinds). */
  files: number
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * What a folder's own entries say it is, or null for a folder that is no
 * project. Sure signs first (an engine's project file, a git repository, a
 * code project's manifest), then creative files (at least
 * MIN_CREATIVE_FILES; named after the program most of them are from).
 */
export function projectKind(entries: readonly FolderEntry[]): ProjectKind | null {
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const e of entries) (e.dir ? dirs : files).add(e.name.toLowerCase())
  const has = (pred: (n: string) => boolean) => [...files].some(pred)
  if (has((n) => n.endsWith('.uproject'))) return { kind: 'Unreal project', strong: true, files: 0 }
  if (dirs.has('assets') && dirs.has('projectsettings')) return { kind: 'Unity project', strong: true, files: 0 }
  if (files.has('project.godot')) return { kind: 'Godot project', strong: true, files: 0 }
  if (dirs.has('.git') || files.has('.git')) return { kind: 'git repository', strong: true, files: 0 }
  if (has((n) => CODE_FILES.has(n) || n.endsWith('.sln'))) return { kind: 'code project', strong: true, files: 0 }
  const byApp = new Map<string, number>()
  let total = 0
  for (const n of files) {
    const app = CREATIVE[extOf(n)]
    if (!app) continue
    byApp.set(app, (byApp.get(app) ?? 0) + 1)
    total++
  }
  if (total < MIN_CREATIVE_FILES) return null
  const top = [...byApp.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!
  return { kind: byApp.size > 1 ? `${top[0]} and other art files` : `${top[0]} files`, strong: false, files: total }
}

/** True for a folder named like one that holds everything (Downloads, Desktop, OneDrive …). */
export function isContainerName(name: string): boolean {
  return CONTAINERS.has(name.trim().toLowerCase())
}

/** The part of the vault the finder needs (FsVault in the app, a fake in tests). */
export interface FinderVault {
  /** vault path → absolute path (throws for one outside the vault). */
  abs(vaultPath: string): string
  /** True for a path the brain never shows (hidden, skipped, left out). */
  isIgnored(vaultPath: string): boolean
  /** Several roots: a path's first segment is a whole drive or folder of the vault, never a project. */
  readonly multi: boolean
}

export interface FindOptions {
  /** Stop looking (a newer run started, the vault closed). */
  cancelled?: () => boolean
  /** Folders looked into so far, now and then. */
  onProgress?: (done: number, total: number) => void
  /** For tests: list a folder. */
  list?: (abs: string) => Promise<FolderEntry[]>
}

async function listFolder(abs: string): Promise<FolderEntry[]> {
  const read = fs.readdir(abs, { withFileTypes: true }).then(
    (ds: Dirent[]) => ds.map((d) => ({ name: d.name, dir: d.isDirectory() })),
    () => [] as FolderEntry[],
  )
  return within(read, LIST_TIMEOUT_MS, [])
}

/**
 * The project folders among `folders` (vault paths from the last scan),
 * shallowest first. A root of the vault, folders the vault skips, folders
 * named like a container, and anything past MAX_FINDER_FOLDERS are not
 * looked into.
 */
export async function findProjects(
  vault: FinderVault,
  folders: readonly string[],
  opts: FindOptions = {},
): Promise<{ candidates: ProjectCandidateDto[]; looked: number; truncated: boolean }> {
  const list = opts.list ?? listFolder
  const depth = (p: string) => p.split('/').length
  const todo: { vaultPath: string; abs: string }[] = []
  let truncated = false
  // Shallowest first: past the cap, the folders left out are the deepest.
  for (const f of folders.filter((x) => typeof x === 'string' && x).sort((a, b) => depth(a) - depth(b))) {
    if ((vault.multi && !f.includes('/')) || vault.isIgnored(f)) continue
    if (isContainerName(f.slice(f.lastIndexOf('/') + 1))) continue
    let abs: string
    try {
      abs = vault.abs(f)
    } catch {
      continue
    }
    if (todo.length >= MAX_FINDER_FOLDERS) {
      truncated = true
      break
    }
    todo.push({ vaultPath: f, abs })
  }
  const found: ProjectCandidateDto[] = []
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < todo.length && !opts.cancelled?.()) {
      const item = todo[next++]!
      const kind = projectKind(await list(item.abs))
      if (kind) found.push({ path: item.vaultPath, name: path.basename(item.abs) || item.vaultPath, ...kind })
      done++
      if (done % 200 === 0) opts.onProgress?.(done, todo.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
  opts.onProgress?.(done, todo.length)
  found.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { candidates: found, looked: done, truncated }
}
