import type { GraphData, NoteId, ParsedNote, VaultAdapter, VaultAsset, VaultChange } from '../types'
import { parseNote } from '../markdown/parse'
import { buildGraph, type BuildGraphOptions } from '../graph/build'
import { SearchIndex } from '../search/index'
import { assetMap, isMediaPath } from './assets'
import { folderOf, idFromPath, isIgnoredPath, isMarkdownPath, normalizeFolderPath, normalizePath } from './paths'

export interface LoadedVault {
  notes: Map<NoteId, ParsedNote>
  graph: GraphData
  search: SearchIndex
  /** Every folder in the vault (vault paths, root '' excluded). */
  folders: Set<string>
  /** Every image file (vault path → asset); empty when the adapter can't list them. */
  assets: Map<string, VaultAsset>
}

export interface LoadProgress {
  phase: 'listing' | 'parsing' | 'indexing'
  done: number
  total: number
}

/**
 * Graph options computed from the current folders, notes and images (e.g. the
 * system layout's folder options, image moons, the Today hub).
 */
export type GraphOptionsFn = (folders: Set<string>, notes: Map<NoteId, ParsedNote>, assets: Map<string, VaultAsset>) => BuildGraphOptions

/** Add a folder and its ancestors to `folders` ('' and ignored paths are skipped). */
function addFolder(folders: Set<string>, path: string): void {
  let cur = normalizeFolderPath(path)
  if (isIgnoredPath(cur)) return
  while (cur !== '' && !folders.has(cur)) {
    folders.add(cur)
    cur = folderOf(cur)
  }
}

/** Every note folder plus its ancestors. */
function foldersOfNotes(notes: Iterable<ParsedNote>): Set<string> {
  const folders = new Set<string>()
  for (const n of notes) addFolder(folders, n.meta.folder)
  return folders
}

/**
 * Read + parse + index a whole vault. Parsing yields to the event loop every
 * batch so a big vault shows progress instead of freezing the window.
 * `folders` comes from `adapter.listFolders()` (plus every note folder), or
 * from the notes alone when the adapter can't list folders.
 */
export async function loadVault(
  adapter: VaultAdapter,
  search = new SearchIndex(),
  onProgress?: (p: LoadProgress) => void,
  graphOptions?: GraphOptionsFn,
): Promise<LoadedVault> {
  onProgress?.({ phase: 'listing', done: 0, total: 0 })
  const files = await adapter.list()
  let listed: string[] | null = null
  if (adapter.listFolders) {
    try {
      listed = await adapter.listFolders()
    } catch (err) {
      console.warn('[aether] failed to list folders', err)
    }
  }
  let assets = new Map<string, VaultAsset>()
  if (adapter.listAssets) {
    try {
      assets = assetMap(await adapter.listAssets())
    } catch (err) {
      console.warn('[aether] failed to list images', err)
    }
  }
  const notes = new Map<NoteId, ParsedNote>()
  const BATCH = 150
  // Yield every BATCH notes and also whenever 40 ms have gone by: a few long notes take seconds each, and 150 of them would be
  // minutes without a repaint (the window shows its progress, and the user can see it is working).
  const YIELD_MS = 40
  let lastYield = performance.now()
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!
    const p = normalizePath(f.path)
    if (!isMarkdownPath(p) || isIgnoredPath(p)) continue
    try {
      const n = parseNote({ ...f, path: p })
      notes.set(n.meta.id, n)
    } catch (err) {
      console.warn('[aether] failed to parse', p, err)
    }
    if (i % BATCH === BATCH - 1 || performance.now() - lastYield > YIELD_MS) {
      onProgress?.({ phase: 'parsing', done: i + 1, total: files.length })
      await new Promise<void>((r) => setTimeout(r, 0))
      lastYield = performance.now()
    }
  }
  onProgress?.({ phase: 'indexing', done: files.length, total: files.length })
  await new Promise<void>((r) => setTimeout(r, 0))
  const folders = foldersOfNotes(notes.values())
  for (const f of listed ?? []) addFolder(folders, f)
  const graph = buildGraph(notes, graphOptions?.(folders, notes, assets))
  await search.rebuildAsync(notes.values())
  return { notes, graph, search, folders, assets }
}

/**
 * Apply a batch of file changes to an existing note map; returns the new map,
 * a rebuilt graph, the touched ids and the new folder set. Links must be
 * re-resolved globally (a new note can resolve previously-ghost links), so the
 * graph is rebuilt — that's ~1ms per 100 notes and happens off the render path.
 *
 * Folders: `opts.folders` (else every note folder) plus the folders of added
 * notes; `addDir` adds a folder and its ancestors; `unlinkDir` removes a folder
 * and every folder under it (the adapter sends `unlink` for the notes itself).
 * `opts.folders` itself is never modified, and it is returned as it is when
 * the batch adds and removes no folder (copy on write): the folder index of
 * the system layout is memoized per Set (`folderUniverse`), so an autosave
 * doesn't re-index a whole drive's folders.
 *
 * Pictures and videos (`isMediaPath`): add / change set the asset (mtime, size), unlink
 * drops it, and `unlinkDir` drops every image under the folder. `opts.assets`
 * is copied on write the same way and returned as it is when no image changed.
 */
export function applyChanges(
  notes: Map<NoteId, ParsedNote>,
  changes: VaultChange[],
  search: SearchIndex,
  opts: { folders?: Set<string>; assets?: Map<string, VaultAsset>; graph?: GraphOptionsFn } = {},
): { notes: Map<NoteId, ParsedNote>; graph: GraphData; touched: NoteId[]; folders: Set<string>; assets: Map<string, VaultAsset> } {
  const next = new Map(notes)
  let assets = opts.assets ?? new Map<string, VaultAsset>()
  let assetsOwned = !opts.assets
  const writableAssets = (): Map<string, VaultAsset> => {
    if (!assetsOwned) {
      assets = new Map(assets)
      assetsOwned = true
    }
    return assets
  }
  let folders = opts.folders ?? foldersOfNotes(notes.values())
  let owned = !opts.folders
  /** The folder set, copied the first time the batch really changes it. */
  const writable = (): Set<string> => {
    if (!owned) {
      folders = new Set(folders)
      owned = true
    }
    return folders
  }
  const addFolderOnce = (path: string): void => {
    const p = normalizeFolderPath(path)
    // An ignored folder (`.git`, `node_modules`) is never added: no copy for it either.
    if (p !== '' && !folders.has(p) && !isIgnoredPath(p)) addFolder(writable(), p)
  }
  const touched: NoteId[] = []
  // Removed folders are collected and dropped in one pass: a deleted tree
  // arrives as one unlinkDir per folder (deepest first), and a full scan per
  // unlinkDir would be quadratic on a whole drive. Flushed before anything
  // that adds folders, so a batch still applies in order.
  const gone = new Set<string>()
  const dropGone = (): void => {
    if (gone.size === 0) return
    const doomed: string[] = []
    for (const f of folders) {
      for (let cur = f; ; ) {
        if (gone.has(cur)) {
          doomed.push(f)
          break
        }
        const i = cur.lastIndexOf('/')
        if (i < 0) break
        cur = cur.slice(0, i)
      }
    }
    // Images under a removed folder go with it.
    if (assets.size) {
      const lost: string[] = []
      for (const p of assets.keys()) {
        for (let cur = folderOf(p); cur !== ''; cur = folderOf(cur)) {
          if (gone.has(cur)) {
            lost.push(p)
            break
          }
        }
      }
      if (lost.length) {
        const m = writableAssets()
        for (const p of lost) m.delete(p)
      }
    }
    gone.clear()
    if (doomed.length === 0) return
    const set = writable()
    for (const f of doomed) set.delete(f)
  }
  for (const c of changes) {
    if (c.kind === 'unlinkDir') {
      const dir = normalizeFolderPath(c.path)
      if (dir !== '') gone.add(dir)
      continue
    }
    if (c.kind === 'addDir') {
      dropGone()
      addFolderOnce(c.path)
      continue
    }
    const p = normalizePath(c.path)
    if (isMediaPath(p)) {
      if (isIgnoredPath(p)) continue
      if (c.kind === 'unlink') {
        if (assets.has(p)) writableAssets().delete(p)
        continue
      }
      const before = assets.get(p)
      const asset: VaultAsset = { path: p }
      if (c.mtime !== undefined && Number.isFinite(c.mtime)) asset.mtime = c.mtime
      if (c.size !== undefined && Number.isFinite(c.size)) asset.size = c.size
      if (before && before.mtime === asset.mtime && before.size === asset.size) continue
      dropGone()
      writableAssets().set(p, asset)
      addFolderOnce(folderOf(p))
      continue
    }
    if (!isMarkdownPath(p) || isIgnoredPath(p)) continue
    const id = idFromPath(p)
    if (c.kind === 'unlink') {
      if (next.delete(id)) {
        search.remove(id)
        touched.push(id)
      }
      continue
    }
    if (typeof c.content !== 'string') continue
    try {
      const file = c.mtime !== undefined ? { path: p, content: c.content, mtime: c.mtime } : { path: p, content: c.content }
      const n = parseNote(file)
      next.set(id, n)
      search.upsert(n)
      touched.push(id)
      dropGone()
      addFolderOnce(n.meta.folder)
    } catch (err) {
      console.warn('[aether] failed to parse', p, err)
    }
  }
  dropGone()
  // buildGraph re-resolves every link from its raw text, so untouched notes
  // don't need a re-parse even when a ghost target just became real.
  const graph = buildGraph(next, opts.graph?.(folders, next, assets))
  return { notes: next, graph, touched, folders, assets }
}
