/**
 * The picture picker's arithmetic: the list it shows (newest first, filtered by a typed substring), which rows are in the page (never
 * more than PICKER_MAX_ROWS, whatever the vault holds), and the multi-select with Shift and Ctrl. No React, no DOM; the panel
 * (Picker.tsx) only draws what this says. Design: docs/design/reference-board.md.
 */
import { isImagePath, type VaultAsset } from '@aether/core'
import { rowWindow, type RowWindow } from '../../windowing'
import { MAX_PICKER_ADD } from './session'

/** Height of a row in the list (px). Fixed, so that the rows can be windowed. */
export const PICKER_ROW_PX = 56
/** The most rows in the page at once. */
export const PICKER_MAX_ROWS = 60
/** Rows drawn beyond each edge of the view. */
export const PICKER_OVERSCAN = 4
/** The search box waits this long after a key before it filters (ms). */
export const PICKER_SEARCH_MS = 200
/** Pictures the picker lists at most; a bigger vault is cut to the newest (the search still looks through these only). */
export const PICKER_MAX_ENTRIES = 100_000

export interface PickerEntry {
  path: string
  /** The file name. */
  name: string
  /** The folder, without a trailing slash ('' at the top). */
  dir: string
  /** Lower-case path, for the search. */
  lower: string
  mtime: number
}

/** Pictures of the list as rows, newest first (those without a time after those with one, then by path). Videos and the like are left out. */
export function toEntries(assets: readonly VaultAsset[]): { entries: PickerEntry[]; cut: number } {
  const all: PickerEntry[] = []
  for (const a of assets) {
    if (!isImagePath(a.path)) continue
    const slash = a.path.lastIndexOf('/')
    all.push({
      path: a.path,
      name: a.path.slice(slash + 1),
      dir: slash >= 0 ? a.path.slice(0, slash) : '',
      lower: a.path.toLowerCase(),
      mtime: typeof a.mtime === 'number' && Number.isFinite(a.mtime) ? a.mtime : 0,
    })
  }
  all.sort((p, q) => q.mtime - p.mtime || (p.lower < q.lower ? -1 : p.lower > q.lower ? 1 : 0))
  const cut = Math.max(0, all.length - PICKER_MAX_ENTRIES)
  return { entries: cut > 0 ? all.slice(0, PICKER_MAX_ENTRIES) : all, cut }
}

/** The entries whose path contains the query, any letter case; the query is trimmed, an empty one keeps everything. */
export function filterEntries(entries: readonly PickerEntry[], query: string): readonly PickerEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return entries
  return entries.filter((e) => e.lower.includes(q))
}

/** The rows in the page for a list of `count` rows scrolled to `scrollTop` in a view `viewportPx` tall: at most PICKER_MAX_ROWS. */
export function pickerWindow(count: number, scrollTop: number, viewportPx: number): RowWindow {
  const w = rowWindow(count, PICKER_ROW_PX, scrollTop, viewportPx, PICKER_OVERSCAN)
  const end = Math.min(w.end, w.start + PICKER_MAX_ROWS)
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
  return { start: w.start, end, padTop: w.padTop, padBottom: (n - end) * PICKER_ROW_PX }
}

export interface PickerSelection {
  /** The chosen paths, in the order they were chosen. */
  paths: ReadonlySet<string>
  /** The row a Shift-click counts from. */
  anchor: number | null
  /** More were asked for than MAX_PICKER_ADD: the first of them are kept. */
  capped: boolean
}

export const EMPTY_PICKER_SELECTION: PickerSelection = Object.freeze({ paths: new Set<string>(), anchor: null, capped: false })

function limited(paths: Iterable<string>, anchor: number | null): PickerSelection {
  const out = new Set<string>()
  let capped = false
  for (const p of paths) {
    if (out.size >= MAX_PICKER_ADD) {
      capped = true
      break
    }
    out.add(p)
  }
  return { paths: out, anchor, capped }
}

/**
 * A click on row `index` of `list`. Plain: only that row. Ctrl (or ⌘): that row joins or leaves. Shift: every row from the anchor
 * to it replaces the selection; Shift with Ctrl adds the run to what was chosen. At most MAX_PICKER_ADD stay chosen.
 */
export function clickRow(sel: PickerSelection, list: readonly { path: string }[], index: number, mods: { shift: boolean; ctrl: boolean }): PickerSelection {
  const row = list[index]
  if (!row) return sel
  if (mods.shift && sel.anchor !== null && sel.anchor < list.length) {
    const lo = Math.min(sel.anchor, index)
    const hi = Math.max(sel.anchor, index)
    const run: string[] = []
    for (let i = lo; i <= hi; i++) run.push(list[i]!.path)
    // The run counts from the anchor outwards, so that the cap keeps the rows nearest to it.
    if (index < sel.anchor) run.reverse()
    return limited(mods.ctrl ? [...sel.paths, ...run] : run, sel.anchor)
  }
  if (mods.ctrl || mods.shift) return toggleRow(sel, list, index)
  return limited([row.path], index)
}

/** Space, or Ctrl-click: the row joins or leaves the selection. */
export function toggleRow(sel: PickerSelection, list: readonly { path: string }[], index: number): PickerSelection {
  const row = list[index]
  if (!row) return sel
  if (sel.paths.has(row.path)) {
    const rest = [...sel.paths].filter((p) => p !== row.path)
    return limited(rest, index)
  }
  return limited([...sel.paths, row.path], index)
}

/** Ctrl+A: the rows of the list (the first MAX_PICKER_ADD of them). */
export function selectAllRows(list: readonly { path: string }[]): PickerSelection {
  return limited(
    (function* () {
      for (const r of list) yield r.path
    })(),
    list.length > 0 ? 0 : null,
  )
}

/** The row the cursor moves to: `delta` rows down (negative: up), kept inside the list. */
export function moveCursor(cursor: number, count: number, delta: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, cursor + delta))
}
