import type { GraphData, NoteId, ParsedNote, VaultAdapter, VaultChange } from '../types'
import { parseNote } from '../markdown/parse'
import { buildGraph } from '../graph/build'
import { SearchIndex } from '../search/index'
import { idFromPath, isIgnoredPath, isMarkdownPath, normalizePath } from './paths'

export interface LoadedVault {
  notes: Map<NoteId, ParsedNote>
  graph: GraphData
  search: SearchIndex
}

export interface LoadProgress {
  phase: 'listing' | 'parsing' | 'indexing'
  done: number
  total: number
}

/**
 * Read + parse + index a whole vault. Parsing yields to the event loop every
 * batch so a big vault shows progress instead of freezing the window.
 */
export async function loadVault(
  adapter: VaultAdapter,
  search = new SearchIndex(),
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadedVault> {
  onProgress?.({ phase: 'listing', done: 0, total: 0 })
  const files = await adapter.list()
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
  const graph = buildGraph(notes)
  search.rebuild(notes.values())
  return { notes, graph, search }
}

/**
 * Apply a batch of file changes to an existing note map; returns the new map,
 * a rebuilt graph and the touched ids. Links must be re-resolved globally
 * (a new note can resolve previously-ghost links), so the graph is rebuilt —
 * that's ~1ms per 100 notes and happens off the render path.
 */
export function applyChanges(
  notes: Map<NoteId, ParsedNote>,
  changes: VaultChange[],
  search: SearchIndex,
): { notes: Map<NoteId, ParsedNote>; graph: GraphData; touched: NoteId[] } {
  const next = new Map(notes)
  const touched: NoteId[] = []
  for (const c of changes) {
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
    } catch (err) {
      console.warn('[aether] failed to parse', p, err)
    }
  }
  // buildGraph re-resolves every link from its raw text, so untouched notes
  // don't need a re-parse even when a ghost target just became real.
  const graph = buildGraph(next)
  return { notes: next, graph, touched }
}
