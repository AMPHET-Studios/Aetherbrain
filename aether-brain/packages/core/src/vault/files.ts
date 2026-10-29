/**
 * Any other file in the vault: an mp3, a pdf, a zip, a spreadsheet, a script, a mod's `.lua` (docs/COSMOLOGY.md, "Every file is a moon").
 * Notes, pictures, videos and 3D models have their own kinds; this is everything else a person keeps in a folder. A file is a moon of its
 * folder's star (a big one, a planet), never a folder, and it is not parsed, thumbnailed or opened by the brain: it opens in the OS.
 *
 * Bounded on purpose. A drive holds millions of files, nearly all of them build output and system clutter, so the junk is left out by name
 * (`isFileMoonPath`), a folder shows at most `FILE_MOONS_PER_FOLDER` of its newest, the whole sky at most `FILE_MOONS_TOTAL`, and the scan
 * stops listing at `FILE_SCAN_MAX`.
 */
import type { NoteId, VaultAsset } from '../types'
import { isAssetPath, imageKey } from './assets'
import { isIgnoredPath, normalizePath } from './paths'

/** The most file moons one folder shows (the newest). */
export const FILE_MOONS_PER_FOLDER = 12
/** The most file moons in the whole sky. */
export const FILE_MOONS_TOTAL = 800
/** The most files the scan lists at all (names only, no stat). */
export const FILE_SCAN_MAX = 20_000

/** What kind of file it is, for its colour: the moons of one kind are tinted alike so a folder reads at a glance. */
export type FileKind = 'audio' | 'document' | 'archive' | 'data' | 'code' | 'design' | 'other'

const KIND_OF: Record<string, FileKind> = {}
const add = (kind: FileKind, exts: string): void => {
  for (const e of exts.split(' ')) KIND_OF[e] = kind
}
add('audio', 'mp3 wav flac ogg oga m4a aac opus wma aiff aif mid midi')
add('document', 'pdf doc docx odt rtf txt epub ppt pptx odp key pages')
add('archive', 'zip rar 7z tar gz tgz bz2 xz iso')
add('data', 'csv tsv json xml yaml yml xls xlsx ods sql db sqlite toml ini')
add('code', 'js mjs cjs ts tsx jsx py lua c cpp h hpp cs rs go java kt swift rb php sh ps1 bat cmd gd gdscript glsl hlsl shader uproject uplugin')
add('design', 'psd psb ai xcf kra blend fbx obj stl dae gltf 3ds ma mb ztl spp sbsar ase aseprite ico')

/** Extensions that are never a file anyone keeps: build output, caches, system and backup clutter (main keeps a copy: `apps/desktop/src/main/fsvault.ts`). */
export const FILE_JUNK_EXT: readonly string[] =
  'map lock log tmp temp bak swp swo pyc pyo class o pdb ilk exp lib a so dylib dll sys cache lnk url crdownload part partial thumb'.split(' ')
/** File names that are clutter whatever the extension (lower case). */
export const FILE_JUNK_NAME: readonly string[] = ['desktop.ini', 'thumbs.db', 'ehthumbs.db', '.ds_store']
/** Folders whose contents are build output or an engine's caches: nothing in them is a keepsake (lower case). */
export const FILE_JUNK_DIR: readonly string[] = [
  'dist',
  'build',
  'out',
  'target',
  'obj',
  'bin',
  '__pycache__',
  'intermediate',
  'binaries',
  'saved',
  'deriveddatacache',
  'library',
  'temp',
  'tmp',
  'cache',
  'coverage',
  'vendor',
  'site-packages',
]
const JUNK_EXT = new Set(FILE_JUNK_EXT)
const JUNK_NAME = new Set(FILE_JUNK_NAME)
const JUNK_DIR = new Set(FILE_JUNK_DIR)

/** The extensions of one kind (lower case, no dot). */
/** What kinds of file the app can make a picture of (the flattened picture of a Photoshop document). Anything else has no preview. */
export function previewKindOf(path: string): 'psd' | undefined {
  return /\.psd$/i.test(path) ? 'psd' : undefined
}

export function fileExtensionsOf(kind: FileKind): string[] {
  return Object.keys(KIND_OF).filter((e) => KIND_OF[e] === kind)
}

/**
 * The kinds the OS may open for the user: a sound, a document, an archive, a data file, a design file. Never code or an unknown kind: the OS
 * runs a script or a program just the same as it opens a song, so those are only revealed in their folder (main keeps a copy of the list).
 */
export const FILE_OPENABLE_KINDS: readonly FileKind[] = ['audio', 'document', 'archive', 'data', 'design']

/** True when the OS may open this file (`FILE_OPENABLE_KINDS`). */
export function isOpenableFile(path: string): boolean {
  return FILE_OPENABLE_KINDS.includes(fileKindOf(path))
}

/** Lower-case extension without the dot, or '' (a name with no dot, or only a leading one). */
export function extOf(path: string): string {
  const name = normalizePath(path).split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The kind of a file by its extension ('other' for one nobody named). */
export function fileKindOf(path: string): FileKind {
  return KIND_OF[extOf(path)] ?? 'other'
}

/**
 * True for a file that can be a moon: not a note (`.md`), not a picture, video or model (those have their own kinds), has an extension,
 * is not hidden and is not clutter (build output, caches, system files), however deep it sits.
 */
export function isFileMoonPath(p: string): boolean {
  const path = normalizePath(p)
  if (path === '' || isIgnoredPath(path) || isAssetPath(path) || /\.md$/i.test(path)) return false
  const ext = extOf(path)
  if (ext === '' || JUNK_EXT.has(ext)) return false
  const parts = path.split('/')
  if (JUNK_NAME.has(parts[parts.length - 1]!.toLowerCase())) return false
  for (let i = 0; i < parts.length - 1; i++) if (JUNK_DIR.has(parts[i]!.toLowerCase())) return false
  return true
}

/** The files the scan found as a map: path → file, with clutter, notes and pictures left out, and a size and time only where they are known. */
export function fileMap(list: Iterable<VaultAsset>): Map<string, VaultAsset> {
  const out = new Map<string, VaultAsset>()
  for (const a of list) {
    const path = normalizePath(a.path)
    if (!isFileMoonPath(path)) continue
    const file: VaultAsset = { path }
    if (a.mtime !== undefined && Number.isFinite(a.mtime)) file.mtime = a.mtime
    if (a.size !== undefined && Number.isFinite(a.size)) file.size = a.size
    out.set(path, file)
  }
  return out
}

/** Graph node id of a file moon: the same `image:<path>` family as pictures (they are leaves that open in the OS), told apart by `image.file`. */
export function fileKey(path: string): NoteId {
  return imageKey(path)
}
