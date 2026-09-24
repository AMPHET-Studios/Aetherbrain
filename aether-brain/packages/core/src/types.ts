/**
 * Aether Brain core data model.
 *
 * A note is a neuron. A [[wikilink]] is a synapse. A folder / PARA area is a
 * constellation. A tag is a colored field. Time is an orbital layer.
 *
 * Everything here is derived from plain markdown files on disk — nothing in
 * this file is a proprietary format. If you delete Aether Brain, the vault is
 * still a folder of .md files.
 */

/** Stable id: vault-relative posix path without the `.md` extension. */
export type NoteId = string

export type NoteType =
  | 'note'
  | 'daily'
  | 'person'
  | 'project'
  | 'area'
  | 'resource'
  | 'inbox'
  | 'concept'
  | 'moc'

export type Area = 'inbox' | 'projects' | 'areas' | 'resources' | 'archive' | 'untagged'

export const AREAS: readonly Area[] = ['inbox', 'projects', 'areas', 'resources', 'archive', 'untagged']
export const NOTE_TYPES: readonly NoteType[] = [
  'note',
  'daily',
  'person',
  'project',
  'area',
  'resource',
  'inbox',
  'concept',
  'moc',
]

export type NoteStatus = string

export interface Heading {
  depth: number
  text: string
  /** Slug used for [[Note#heading]] resolution (lowercased, trimmed). */
  slug: string
}

export interface NoteMeta {
  id: NoteId
  /** frontmatter.title, else first H1, else filename. */
  title: string
  /** Vault-relative posix path including `.md`. */
  path: string
  /** Vault-relative folder (posix, '' for root). */
  folder: string
  area: Area
  type: NoteType
  tags: string[]
  /** ISO date string or null. */
  created: string | null
  updated: string | null
  status: NoteStatus | null
  wordCount: number
  headings: Heading[]
  aliases: string[]
}

export type LinkKind = 'wikilink' | 'embed' | 'tag'

export interface Link {
  from: NoteId
  /** Resolved target id, or the raw target text if unresolved (see `resolved`). */
  to: NoteId
  /** Original wikilink text between the brackets, e.g. `Note Title#Heading|alias`. */
  raw: string
  kind: LinkKind
  /** Target heading slug when written as [[Note#Heading]]. */
  heading?: string
  /** Display alias when written as [[Note|alias]]. */
  alias?: string
  /** Whether `to` points to an existing note. */
  resolved: boolean
  /** Character offset of the link inside the body (post-frontmatter). */
  offset: number
}

/** A raw file as read from a vault adapter. */
export interface VaultFile {
  /** Vault-relative posix path (e.g. `Resources/Drawing/Value Structure.md`). */
  path: string
  content: string
  /** Last-modified epoch ms if known. */
  mtime?: number
}

/** Frontmatter after YAML parsing — always a plain object. */
export type Frontmatter = Record<string, unknown>

export interface ParsedNote {
  meta: NoteMeta
  frontmatter: Frontmatter
  /** Raw markdown body (frontmatter stripped). */
  body: string
  /** Full original file content, unchanged. */
  raw: string
  links: Link[]
  /** Tags found inline in the body (#tag), excluding frontmatter tags. */
  inlineTags: string[]
  /** Plain text (no markdown syntax), used for search + unlinked mentions. */
  plain: string
  mtime?: number
}

export interface GraphNode {
  id: NoteId
  title: string
  area: Area
  type: NoteType
  tags: string[]
  /** true for unresolved link targets (a note that should exist but doesn't). */
  ghost: boolean
  inDegree: number
  outDegree: number
  degree: number
  created: number | null
  updated: number | null
  wordCount: number
}

export interface GraphEdge {
  from: NoteId
  to: NoteId
  kind: LinkKind
  /** Number of links collapsed into this edge. */
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** id -> index in nodes[] */
  index: Map<NoteId, number>
  /** id -> ids that link to it */
  backlinks: Map<NoteId, Set<NoteId>>
  /** id -> ids it links to */
  outlinks: Map<NoteId, Set<NoteId>>
  /** ghost id -> ids referencing it */
  unresolved: Map<NoteId, Set<NoteId>>
  orphans: NoteId[]
  tagCounts: Map<string, number>
  areaCounts: Map<Area, number>
}

export interface SearchHit {
  id: NoteId
  score: number
  title: string
  /** Fields that matched (title, tags, headings, body, path). */
  match: string[]
  /** Short excerpt around the first body match (already trimmed). */
  snippet: string
}

export type VaultChangeKind = 'add' | 'change' | 'unlink'

export interface VaultChange {
  kind: VaultChangeKind
  path: string
  content?: string
  mtime?: number
}

/**
 * Anything that can act as a vault. Implemented by:
 *  - DemoVaultAdapter (bundled markdown, edits persisted in IndexedDB)
 *  - FsAccessVaultAdapter (browser File System Access API)
 *  - ElectronVaultAdapter (real folder on disk via IPC + chokidar)
 */
export interface VaultAdapter {
  readonly kind: 'demo' | 'fs-access' | 'electron' | 'memory'
  readonly name: string
  /** Absolute path or human label of the vault root. */
  readonly location: string
  readonly readOnly: boolean
  list(): Promise<VaultFile[]>
  read(path: string): Promise<string | null>
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Subscribe to external changes. Returns an unsubscribe function. */
  watch(cb: (changes: VaultChange[]) => void): () => void
}
