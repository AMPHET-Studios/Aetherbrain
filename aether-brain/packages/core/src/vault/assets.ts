/**
 * Picture files in the vault: concept art, references, Concept Forge
 * critiques. They are not notes (nothing parses them), but they are part of
 * the brain: embedded ones (`![[gate.png]]`) link from their notes, and in
 * the system layout each folder shows its newest pictures as thumbnail moons.
 */
import type { NoteId, VaultAsset } from '../types'
import { folderOf, isIgnoredPath, normalizePath } from './paths'

/** Picture extensions the brain shows (lowercase, no dot). SVG is left out on purpose: it can carry scripts. */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

/** True for a path (or file name) with a picture extension, any letter case. */
export function isImagePath(p: string): boolean {
  return IMAGE_RE.test(p)
}

/** Graph node id of an image: `image:<vault path>`. */
export function imageKey(path: string): NoteId {
  return `image:${normalizePath(path)}`
}

export function isImageId(id: NoteId): boolean {
  return id.startsWith('image:')
}

/** Vault path of an image id (inverse of `imageKey`). */
export function imagePathOf(id: NoteId): string {
  return id.slice('image:'.length)
}

/** Id of the Today hub (one per graph). */
export const TODAY_ID: NoteId = 'today:'

export function isTodayId(id: NoteId): boolean {
  return id === TODAY_ID
}

/**
 * True for graph ids that are not notes: folders, ghosts, images and the
 * Today hub. Anything that takes a note id (open, rename, tasks…) guards with it.
 */
export function isVirtualId(id: NoteId): boolean {
  return id.startsWith('folder:') || id.startsWith('ghost:') || id.startsWith('image:') || id === TODAY_ID
}

/** The file name of an image path (`Art/gate.png` → `gate.png`). */
export function imageFileName(path: string): string {
  const p = normalizePath(path)
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Assets of a list, keyed by normalized path: images only, ignored folders skipped, the last entry per path wins. */
export function assetMap(list: Iterable<VaultAsset>): Map<string, VaultAsset> {
  const out = new Map<string, VaultAsset>()
  for (const a of list) {
    const path = normalizePath(a.path)
    if (!isImagePath(path) || isIgnoredPath(path)) continue
    const asset: VaultAsset = { path }
    if (a.mtime !== undefined && Number.isFinite(a.mtime)) asset.mtime = a.mtime
    if (a.size !== undefined && Number.isFinite(a.size)) asset.size = a.size
    out.set(path, asset)
  }
  return out
}

/**
 * Resolves image link targets (`gate.png`, `Art/gate.png`, `./gate.png`) to
 * vault paths, Obsidian style: the exact vault path, then the path relative
 * to the linking note's folder, then the file name anywhere in the vault
 * (case-insensitive; several matches: the one nearest the note's folder, then
 * the shortest path, then the first by name).
 */
export class AssetResolver {
  private byPath = new Map<string, string>()
  private byName = new Map<string, string[]>()

  /** `assets`: normalized vault paths (the keys of an `assetMap`). */
  constructor(assets: Iterable<string>) {
    for (const p of assets) {
      const lower = p.toLowerCase()
      this.byPath.set(lower, p)
      const name = lower.slice(lower.lastIndexOf('/') + 1)
      const list = this.byName.get(name)
      if (list) list.push(p)
      else this.byName.set(name, [p])
    }
  }

  get size(): number {
    return this.byPath.size
  }

  /** Vault path of the image `target` names from a note in `fromFolder`, or null. */
  resolve(target: string, fromFolder = ''): string | null {
    const raw = normalizePath(target.trim()).replace(/^(\.\/)+/, '')
    if (!raw || !isImagePath(raw)) return null
    const exact = this.byPath.get(raw.toLowerCase())
    if (exact) return exact
    if (fromFolder) {
      const rel = joinRelative(fromFolder, raw)
      if (rel !== null) {
        const hit = this.byPath.get(rel.toLowerCase())
        if (hit) return hit
      }
    }
    const cands = this.byName.get(imageFileName(raw).toLowerCase())
    if (!cands?.length) return null
    // A path written with folders must end with them (`Art/gate.png` ≠ `Refs/gate.png`),
    // even when only one file has that name: Obsidian leaves such a link unresolved.
    const suffix = raw.includes('/') ? `/${raw.toLowerCase()}` : null
    const fitting = suffix ? cands.filter((c) => `/${c.toLowerCase()}`.endsWith(suffix)) : cands
    if (!fitting.length) return null
    if (fitting.length === 1) return fitting[0] ?? null
    return [...fitting].sort((a, b) => nearness(b, fromFolder) - nearness(a, fromFolder) || a.length - b.length || a.localeCompare(b))[0] ?? null
  }
}

/** `folder` + `rel` with `..` and `.` segments applied; null when it climbs above the vault. */
function joinRelative(folder: string, rel: string): string | null {
  const out = folder ? folder.split('/') : []
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

/** How many leading folders `path` shares with `folder` (more = nearer). */
function nearness(path: string, folder: string): number {
  if (!folder) return 0
  const a = folderOf(path).toLowerCase().split('/')
  const b = folder.toLowerCase().split('/')
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/** The title an image node shows: its file name. */
export function imageTitle(path: string): string {
  return imageFileName(path)
}

/** File name without its extension (`gate.png` → `gate`). */
export function imageBaseName(path: string): string {
  return imageFileName(path).replace(IMAGE_RE, '')
}
