/**
 * The librarian between main and the renderer: what the panel shows and
 * sends. Plain data (structured-clone safe).
 */

export type LibraryState = 'idle' | 'analyzing' | 'planned' | 'copying' | 'done'

export type LibraryPhaseDto = 'scanning' | 'reading' | 'looking' | 'comparing' | 'copying' | 'indexing'

export interface LibraryProgressDto {
  phase: LibraryPhaseDto
  done: number
  /** Null while unknown (the scan). */
  total: number | null
  /** When this phase started (epoch ms), for the time left. */
  since: number
}

export interface LibraryModelDto {
  label: string
  /** About how big the download is. */
  mb: number
  ready: boolean
  /** Bytes on disk when ready. */
  bytes: number
  downloading: boolean
  done: number
  total: number | null
  error: string | null
}

export interface LibraryGenreDto {
  /** Null for types without genres (Documents, Other). */
  genre: string | null
  count: number
  bytes: number
  years: { year: string; count: number }[]
  /** Plan item ids of a few of its pictures, newest first (`libraryThumb`). */
  samples: number[]
}

export interface LibraryTypeDto {
  type: string
  count: number
  bytes: number
  genres: LibraryGenreDto[]
}

export interface LibraryPlanDto {
  source: string
  dest: string
  /** Pictures found by name. */
  found: number
  tiny: number
  unreadable: number
  installs: number
  truncated: boolean
  /** New pictures to copy, and their bytes. */
  toCopy: number
  bytes: number
  duplicates: number
  /** In the library from an earlier run. */
  already: number
  /** Deleted from the library since an earlier run: left out. */
  removed: number
  vision: { colours: boolean; model: boolean; error: string | null }
  types: LibraryTypeDto[]
  taste: { tag: string; label: string; count: number }[]
  years: { year: string; count: number }[]
  /** Free space where the library goes, when known. */
  freeBytes: number | null
}

export interface LibraryResultDto {
  copied: number
  bytes: number
  alreadyThere: number
  failed: { rel: string; error: string }[]
  notes: number
  stopped: boolean
  /** Something no picture is to blame for (the manifest could not be written), or null. */
  warning: string | null
  /** The hub note as a vault path, when the library is inside the brain's folders. */
  hubPath: string | null
  /** The library folder is inside the brain's folders (else the panel offers to add it). */
  inVault: boolean
}

export interface LibraryStatusDto {
  source: string
  dest: string
  includeTiny: boolean
  state: LibraryState
  progress: LibraryProgressDto | null
  plan: LibraryPlanDto | null
  result: LibraryResultDto | null
  error: string | null
  model: LibraryModelDto
}

export interface LibraryPatch {
  source?: string
  dest?: string
  includeTiny?: boolean
}

export type LibraryModelAction = 'download' | 'cancel' | 'remove'

export type LibraryEventDto = { kind: 'status'; status: LibraryStatusDto } | { kind: 'progress'; progress: LibraryProgressDto | null; model: LibraryModelDto | null }
