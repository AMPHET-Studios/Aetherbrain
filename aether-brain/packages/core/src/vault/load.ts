import type { GraphData, NoteId, ParsedNote, VaultAdapter, VaultChange } from '../types'
import { parseNote } from '../markdown/parse'
import { buildGraph, type BuildGraphOptions } from '../graph/build'
import { SearchIndex } from '../search/index'
import { folderOf, idFromPath, isIgnoredPath, isMarkdownPath, normalizeFolderPath, normalizePath } from './paths'

export interface LoadedVault {
  notes: Map<NoteId, ParsedNote>
  graph: GraphData
  search: SearchIndex
  /** Every folder in the vault (vault paths, root '' excluded). */
  folders: Set<string>
}

export interface LoadProgress {
  phase: 'listing' | 'parsing' | 'indexing'
  done: number
  total: number
}

/** Graph options computed from the current folders and notes (e.g. the system layout's folder options). */
export type GraphOptionsFn = (folders: Set<string>, notes: Map<NoteId, ParsedNote>) => BuildGraphOptions

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
  const notes = new Map<NoteId, ParsedNote>()
  const BATCH = 150
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
    if (i % BATCH === BATCH - 1) {
      onProgress?.({ phase: 'parsing', done: i + 1, total: files.length })
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  }
  onProgress?.({ phase: 'indexing', done: files.length, total: files.length })
  await new Promise<void>((r) => setTimeout(r, 0))
  const folders = foldersOfNotes(notes.values())
  for (const f of listed ?? []) addFolder(folders, f)
  const graph = buildGraph(notes, graphOptions?.(folders, notes))
  search.rebuild(notes.values())
  return { notes, graph, search, folders }
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
 */
export function applyChanges(
  notes: Map<NoteId, ParsedNote>,
  changes: VaultChange[],
  search: SearchIndex,
  opts: { folders?: Set<string>; graph?: GraphOptionsFn } = {},
): { notes: Map<NoteId, ParsedNote>; graph: GraphData; touched: NoteId[]; folders: Set<string> } {
  const next = new Map(notes)
  const folders = opts.folders ? new Set(opts.folders) : foldersOfNotes(notes.values())
  const touched: NoteId[] = []
  // Removed folders are collected and dropped in one pass: a deleted tree
  // arrives as one unlinkDir per folder (deepest first), and a full scan per
  // unlinkDir would be quadratic on a whole drive. Flushed before anything
  // that adds folders, so a batch still applies in order.
  const gone = new Set<string>()
  const dropGone = (): void => {
    if (gone.size === 0) return
    for (const f of folders) {
      for (let cur = f; ; ) {
        if (gone.has(cur)) {
          folders.delete(f)
          break
        }
        const i = cur.lastIndexOf('/')
        if (i < 0) break
        cur = cur.slice(0, i)
      }
    }
    gone.clear()
  }
  for (const c of changes) {
    if (c.kind === 'unlinkDir') {
      const dir = normalizeFolderPath(c.path)
      if (dir !== '') gone.add(dir)
      continue
    }
    if (c.kind === 'addDir') {
      dropGone()
      addFolder(folders, c.path)
      continue
    }
    const p = normalizePath(c.path)
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
      addFolder(folders, n.meta.folder)
    } catch (err) {
      console.warn('[aether] failed to parse', p, err)
    }
  }
  dropGone()
  // buildGraph re-resolves every link from its raw text, so untouched notes
  // don't need a re-parse even when a ghost target just became real.
  const graph = buildGraph(next, opts.graph?.(folders, next))
  return { notes: next, graph, touched, folders }
}
