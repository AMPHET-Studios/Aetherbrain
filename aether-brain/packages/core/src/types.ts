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
  | 'board'

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
  'board',
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

/**
 * Kind of a graph edge: a link kind, or 'today' for the beams of the Today
 * hub (graph-only: the hub → every note holding one of today's tasks).
 */
export type EdgeKind = LinkKind | 'today'

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
  /**
   * `raw` is a vault path to be read as it is, not wikilink text (no `|alias`, no `#heading`): the picture of a reference board's
   * `pic` line, whose path holds characters a wikilink cannot. Absent for every link read from `[[...]]`.
   */
  literal?: true
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
  /**
   * Set when the note was too long to read as markdown whole (`PARSE_MAX_CHARS`): the number of characters at its start that were.
   * Its links, tags and headings come from that part only; the search text goes a little further (`PLAIN_MAX_CHARS`).
   */
  partial?: number
  mtime?: number
}

/**
 * What a graph node stands for. Notes and ghosts are the classic neurons;
 * folder nodes only exist when the graph is built with folders (the "system"
 * layout), where folders become stars and planets and notes orbit them.
 * Image nodes are picture files (id `image:<vault path>`): embedded ones
 * (`![[art.png]]`) in every layout, and in the system layout the newest
 * images of each shown folder as thumbnail moons. The Today hub (id
 * `today:`) is one glowing node that gathers today's tasks from every note.
 */
export type NodeKind = 'note' | 'ghost' | 'folder' | 'image' | 'today'

/**
 * Role of a folder node in the system layout (see docs/COSMOLOGY.md).
 *  - root:    the vault itself (one per graph, id `folder:`); a galaxy when the vault is one folder or drive
 *  - mount:   a top-level root folder in a multi-root vault (a drive such as D: or F:): a galaxy
 *  - project: a folder bound to a project note: a brighter, bigger star
 *  - folder:  any other folder: a star
 */
export type FolderRole = 'root' | 'mount' | 'project' | 'folder'

/**
 * What a folder holds, everything under it (the folders inside it included), as the brain knows it without looking at the disk:
 * the notes and their words, and the pictures, videos and 3D models it has listed. A folder that a galaxy took out of it (see
 * `FolderNodeInfo.galaxyLevel`) no longer counts what that galaxy holds.
 */
export interface FolderData {
  notes: number
  words: number
  pictures: number
  videos: number
  models: number
}

/** Why a galaxy mark does not count (docs/COSMOLOGY.md, "A galaxy is a folder you mark"). */
export type GalaxyMarkIgnored = 'drive' | 'depth' | 'count'

export interface FolderNodeInfo {
  /** Vault path of the folder ('' = vault root). */
  path: string
  role: FolderRole
  /** 0 = vault root; mounts are depth 1 in a multi-root vault. */
  depth: number
  /** True for the vault root of a single-root vault: a galaxy itself (a multi-root vault's root is only the origin). */
  galaxy?: boolean
  /**
   * Set on a project folder the user marked as a galaxy (`scale: galaxy` on its project note) when the mark counts: how deep it nests,
   * counting the vault (or a drive) as level 1, so 2 or 3. It is a galaxy of its own: its sub-folders lie on its disc, and its
   * `GraphNode.parent` is the galaxy it sits on, not the folder above it.
   */
  galaxyLevel?: number
  /** Set on a project folder marked as a galaxy whose mark does not count, and why: it stays an ordinary star. */
  markIgnored?: GalaxyMarkIgnored
  /** What the folder holds, for the inspector (see `FolderData`). Absent on a node made by hand. */
  data?: FolderData
  /**
   * How much the folder holds in note-equivalents (`dataWeight`): the one number a star's size grows with. Absent on a node made by
   * hand (the size then comes from its counts).
   */
  weight?: number
  /** True for the Bio star: the folder `Bio` at the vault's home (`FolderGraphOptions.bio`), drawn as the one big, bright, blue star. */
  bio?: boolean
  /**
   * True for the Bio star before its folder exists (`FolderGraphOptions.bioPlaceholder`): a star with nothing in it, standing
   * where the folder will be, that the inspector's button makes real. It has no folder on disk to reveal, leave out or open.
   */
  placeholder?: boolean
  /** Project note bound to this folder (the star's note), if any. */
  projectId: NoteId | null
  /** True when some ancestor folder is a project folder (its planets and moons). */
  inProject: boolean
  /** Direct subfolders that exist on disk (shown or not). */
  childFolders: number
  /** Direct subfolders that are not in the graph (collapsed or over the folder cap). */
  hiddenFolders: number
  /** Notes directly inside this folder. */
  notes: number
  /** Notes anywhere under this folder. */
  totalNotes: number
  /** Image files directly inside this folder (on disk, shown or not). */
  images: number
  /** Image moons drawn for this folder (the newest `images`, up to the per-folder cap). */
  shownImages: number
}

/**
 * Present on a reference board (`type: board`) in the system layout when pictures of its own orbit it: the board is a
 * sun, a star of its own, and a picture on it orbits it instead of its folder (docs/COSMOLOGY.md).
 */
export interface BoardSunInfo {
  /** Pictures (and videos) that orbit this board: those on it that no earlier board already holds. */
  pictures: number
}

/** Present on image nodes. */
export interface ImageNodeInfo {
  /** Vault path of the picture, extension included (`Projects/PORTALz/Art/gate.png`). */
  path: string
  /** Last-modified epoch ms, when known. */
  mtime: number | null
  /** Bytes, when known. */
  size: number | null
  /** Notes that embed or link it. */
  embeddedBy: number
  /** True for a video (`isVideoPath`): shown as one still frame, never played in the brain. */
  video?: boolean
  /** True for a 3D model (`isModelPath`): shown as one lit still the thumbnail helper draws, opened in the OS's 3D app. */
  model?: boolean
  /** Present while the picture is a card of the open star gallery. */
  gallery?: GalleryCardInfo
}

/** A picture's place in the open star gallery (see `ImageGraphOptions.gallery`). */
export interface GalleryCardInfo {
  /** The project star the card floats around (`folder:<path>`). */
  star: NoteId
  /** Place in the gallery, newest picture first (0, 1, …). */
  rank: number
  /**
   * True when the picture is in the graph for the gallery only (not a moon or
   * a linked picture): it holds no orbit of its own, so opening the gallery
   * moves nothing else.
   */
  only: boolean
}

/** The open star gallery of a system graph: every picture under a project star, as cards around it. */
export interface GalleryInfo {
  /** The project star (`folder:<path>`). */
  star: NoteId
  /** The star's folder (vault path). */
  path: string
  /** Pictures (videos included) drawn as cards. */
  cards: number
  /** How many of the cards are videos. */
  videos: number
  /** Pictures under the star's folder on disk (all of them, cards or not). */
  total: number
}

/** Present on the Today hub: the counts of the daily brief it stands for. */
export interface TodayNodeInfo {
  /** The day the brief is for (YYYY-MM-DD, local time). */
  date: string
  overdue: number
  /** Due or scheduled today, flagged #today, or in today's daily note. */
  today: number
  /** First open task of active projects with nothing due. */
  next: number
  total: number
}

export interface GraphNode {
  id: NoteId
  title: string
  area: Area
  type: NoteType
  tags: string[]
  kind: NodeKind
  /** true for unresolved link targets (a note that should exist but doesn't). Same as kind === 'ghost'. */
  ghost: boolean
  /**
   * Structural parent for the system layout: a folder node id (or, for a
   * ghost, the first note that links to it; for a picture on a reference
   * board, that board). null for the vault root and for every node when the
   * graph was built without folders. A folder marked as a galaxy that counts
   * (`folder.galaxyLevel`) is the exception: its parent is the galaxy it sits
   * on (the vault, a drive or another galaxy), not the folder it is in.
   */
  parent: NoteId | null
  /** Present on folder nodes only. */
  folder?: FolderNodeInfo
  /** Present on image nodes only. */
  image?: ImageNodeInfo
  /** Present on a reference board that has pictures orbiting it (the system layout only): a sun. */
  board?: BoardSunInfo
  /** Present on the Today hub only. */
  today?: TodayNodeInfo
  inDegree: number
  outDegree: number
  degree: number
  created: number | null
  updated: number | null
  wordCount: number
  /**
   * How soon this needs you, 0 to 1 (`markdown/urgency.ts`). A note: its most urgent open task. A picture or
   * video: the most urgent note that embeds it. A folder: its whole system (`systemUrgency`). Only present when the
   * graph was built with `urgency`; the system layout draws it as orbit speed and star brightness.
   */
  urgency?: number
}

export interface GraphEdge {
  from: NoteId
  to: NoteId
  kind: EdgeKind
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
  /** Which folders the graph shows as nodes; null when built without folders. */
  folderSelection: FolderSelection | null
  /** The open star gallery (system graphs only); absent or null when none is open. */
  gallery?: GalleryInfo | null
}

/** Result of `selectFolders`: the folder nodes a system graph shows. */
export interface FolderSelection {
  /** Visible folder vault paths, always including '' (the root). */
  visible: Set<string>
  /** Direct subfolder counts on disk, per folder ('' included). */
  childCount: Map<string, number>
  /** Direct subfolders not visible, per visible folder. */
  hidden: Map<string, number>
  /** How many optional folders were dropped by maxFolders. */
  dropped: number
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

/**
 * File changes, plus folder creation/removal ('addDir' / 'unlinkDir', path =
 * the folder). Picture, video and 3D model files (`isAssetPath`) come as add /
 * change / unlink without `content` (mtime and size when known); everything
 * that is not a note, a picture, a video or a model is never reported.
 */
export type VaultChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

export interface VaultChange {
  kind: VaultChangeKind
  path: string
  content?: string
  mtime?: number
  /** Bytes (image changes, when known). */
  size?: number
}

/** A picture file in the vault (png, jpg, jpeg, webp, gif, bmp, avif). */
export interface VaultAsset {
  /** Vault path, extension included. */
  path: string
  mtime?: number
  size?: number
}

/** One folder on disk that is part of the vault. */
export interface VaultRootInfo {
  /** Absolute path on disk (e.g. `D:\` or `/home/me/notes`). */
  path: string
  /**
   * Top-level vault folder this root appears under when the vault has several
   * roots (`D` for `D:\`, else the folder name, de-duplicated). Unused ('') in
   * a single-root vault, whose paths are relative to the root itself.
   */
  mount: string
  /** Human label, e.g. `D:\` or `Notes`. */
  label: string
}

/**
 * Anything that can act as a vault. Implemented by:
 *  - DemoVaultAdapter (bundled markdown, edits persisted in IndexedDB)
 *  - FsAccessVaultAdapter (browser File System Access API)
 *  - ElectronVaultAdapter (folders on disk via IPC; native recursive watch)
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
  /**
   * Create a NEW file: fails (an Error whose message contains `EEXIST`) when
   * anything already exists at the path, including a file the vault ignores
   * or, on case-insensitive disks, one whose name differs only in case. Use it
   * for every new note so creating never overwrites. Optional: callers fall
   * back to `read(path) === null` + `write` when an adapter lacks it.
   */
  create?(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Subscribe to external changes. Returns an unsubscribe function. */
  watch(cb: (changes: VaultChange[]) => void): () => void
  /**
   * Roots on disk. More than one entry means a multi-root vault: every vault
   * path then starts with the root's `mount` segment (`D/Projects/x.md`).
   * Absent or one entry: paths are relative to the single root.
   */
  readonly roots?: VaultRootInfo[]
  /** Every folder in the vault as vault paths (no trailing slash, root '' excluded). */
  listFolders?(): Promise<string[]>
  /** Create a folder (and any missing parents). Emits an 'addDir' change. */
  createFolder?(path: string): Promise<void>
  /** Show a file or folder in the OS file manager (desktop only). */
  reveal?(path: string): Promise<void>
  /** Every image file in the vault (skipped folders excluded). Absent: the vault has no images. */
  listAssets?(): Promise<VaultAsset[]>
  /**
   * A small preview of an image, at most `size` px on its longer side (PNG or
   * JPEG), or null when it can't be read or decoded. Absent: no thumbnails.
   */
  thumbnail?(path: string, size: number): Promise<Blob | null>
  /**
   * The picture file itself, whole and undecoded (the reference board draws
   * it at full size when zoomed in; `thumbnail` stops at 1024 px), as a Blob
   * typed by its extension. Null when the path is not a picture of the vault
   * (a video, a note, a path outside it), it is missing, unreadable or empty,
   * or it is over 64 MB. Never rejects. Absent: only previews can be read.
   */
  readAsset?(path: string): Promise<Blob | null>
  /**
   * Create a NEW image file from its bytes (a PNG from Concept Forge, a
   * dropped picture). Create-only like `create` (EEXIST when anything is
   * there); only image paths. Reports an 'add' change for it.
   */
  createAsset?(path: string, data: Uint8Array): Promise<void>
  /** Open an image in the OS default app (desktop only). */
  openAsset?(path: string): Promise<void>
  /**
   * Leave a folder out of the brain (desktop only). Nothing on disk changes;
   * what was shown under it goes away through the change feed.
   */
  hideFolder?(path: string): Promise<void>
  /** Let a folder left out with hideFolder back in; what is in it arrives through the change feed. */
  unhideFolder?(path: string): Promise<void>
  /**
   * True when changes that arrived while the vault loaded could not all be
   * kept (a huge burst on a whole drive): the app offers a rescan.
   */
  readonly overflowed?: boolean
}
