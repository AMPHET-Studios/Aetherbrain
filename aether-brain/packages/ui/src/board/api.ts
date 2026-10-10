/**
 * The reference board's seams: what the board view needs from its host (the docked view in the brain window, or the floating
 * window), what the controller takes in and gives out, and how pictures are cached. Types only, no behaviour: the contract the
 * controller (controller.ts), the picture cache (imageCache.ts), the canvas renderer (renderer.ts) and the React shell
 * (BoardView.tsx) are written against. Design: docs/design/reference-board.md.
 *
 * Everything in a board that is not a picture's pixels is plain data from @aether/core (BoardDoc), so the controller runs, and is
 * tested, in node with no DOM.
 */
import type { BoardDoc, BoardItem, Rect, TextMetrics, Vec2, VaultAsset } from '@aether/core'

/* ---------------------------------------------------------------- host --- */

/** Where a board's pictures come from and go to. Implemented over the store (docked) or the bridge (floating window). */
export interface BoardPictureHost {
  /**
   * A PNG or JPEG of at most `px` on its longer side (never enlarged), or null when there is none (a picture over the host's own
   * pixel cap has none: the loader then makes the preview from `original`). A host that knows why it cannot answer may REJECT with an
   * error carrying `reason: ImageFailure` ('missing', 'too-large': the placeholder then says so); any other rejection is 'unreadable'.
   */
  preview(path: string, px: number): Promise<Blob | null>
  /**
   * The picture file itself (at most 64 MB), or null when it cannot be read. May reject with a `reason` like `preview`: a file over the
   * host's byte limit is 'too-large'. The loader reads the pixel size from the first bytes and decodes nothing above 150 megapixels.
   */
  original(path: string): Promise<Blob | null>
  /**
   * Writes pictures into this board's own folder (create-only, a taken name gets " 2"). Resolves with the vault path of each, in the
   * order given; null for one that was refused (not an image, too big, ...).
   */
  add(files: { name: string; data: Uint8Array }[]): Promise<(string | null)[]>
  /** Every picture of the vault (for the picker). */
  list(): Promise<VaultAsset[]>
  /** Whether the vault has this picture now (a board keeps the place of one that is gone, drawn as a missing picture). */
  exists(path: string): boolean
  /** Open in the system's image program (desktop). */
  open?(path: string): void
  /** Show in the file manager (desktop). */
  reveal?(path: string): void
  /** Close the board and select the picture's node in the brain (docked only). */
  showInBrain?(path: string): void
  /** The set of pictures changed (one was added, removed or replaced). Returns the unsubscribe. */
  onChange?(cb: () => void): () => void
}

/** Floating-window controls; present only on the desktop. */
export interface BoardWindowHost {
  /** This view is the floating window (true) or the docked view (false). */
  floating: boolean
  alwaysOnTop: boolean
  /** 0.2 to 1. */
  opacity: number
  /** Window opacity works on this platform (Windows, macOS). */
  supportsOpacity: boolean
  /** Docked: open this board in the floating window (and rest here). Floating: nothing. */
  popOut(): void
  /** Floating: close the window and give the board back to the docked view. Docked: nothing. */
  dock(): void
  setAlwaysOnTop(on: boolean): void
  setOpacity(opacity: number): void
}

export type BoardTone = 'info' | 'success' | 'error'

export interface BoardHost {
  /** The board's note: a vault path ending in .md. */
  readonly path: string
  /** The board's title. */
  readonly title: string
  /**
   * What tells this board from a board of the same path in another vault, for what the browser remembers about it (the camera, the copy
   * of a board that could not be saved): the vault's location and the path. Defaults to `path`.
   */
  readonly stateKey?: string
  /** Reads the whole note (the raw text, frontmatter included). */
  load(): Promise<string>
  /**
   * Writes the whole note. Callers debounce; the host serialises writes and never overwrites a newer outside change silently.
   * `expectedBase` is the text `raw` was made from: the host refuses (BoardChangedOutsideError) when the note on disk is no longer
   * that text, whatever the host itself last read (a reload that landed in between must not make a stale text look fresh).
   * The floating window's host sends it with the write in ONE call and main compares, so there is no read-then-write gap.
   */
  save(raw: string, expectedBase?: string): Promise<void>
  /** The note changed somewhere else (an editor, an AI, another window). Returns the unsubscribe. */
  onExternalChange?(cb: () => void): () => void
  pictures: BoardPictureHost
  toast(text: string, tone?: BoardTone, action?: { label: string; run(): void }): void
  /** Copy text to the system clipboard (the sandbox has no navigator.clipboard). */
  copyText(text: string): Promise<void>
  window?: BoardWindowHost
}

/* --------------------------------------------------------------- input --- */

/** A pointer event in the canvas's own CSS pixels (0,0 is its top-left corner). */
export interface PointerIn {
  id: number
  x: number
  y: number
  /** 0 primary (left, pen tip, touch), 1 middle, 2 secondary (right, pen barrel). */
  button: number
  /** Bit field as in PointerEvent.buttons. */
  buttons: number
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
  pointerType: 'mouse' | 'pen' | 'touch'
  /** 0 to 1; 0.5 for a mouse. */
  pressure: number
  /** Milliseconds, monotonic (event.timeStamp). */
  time: number
}

export interface WheelIn {
  x: number
  y: number
  deltaX: number
  deltaY: number
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export interface KeyIn {
  /** KeyboardEvent.key ('a', 'Delete', ' ' ...). */
  key: string
  code: string
  down: boolean
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
  repeat: boolean
}

/* -------------------------------------------------------------- tools ---- */

export type BoardTool = 'select' | 'hand' | 'note' | 'pen' | 'line' | 'rect' | 'ellipse' | 'eraser' | 'sampler' | 'crop'

/** Where on a selected item the pointer is. */
export type HandleKind = 'body' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'crop-nw' | 'crop-n' | 'crop-ne' | 'crop-e' | 'crop-se' | 'crop-s' | 'crop-sw' | 'crop-w'

/** The box drawn round the selection: four corners (board units, in order top-left, top-right, bottom-right, bottom-left of the box). */
export interface SelectionBox {
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Where the rotate handle sits (board units), or null when the selection cannot be rotated. */
  rotateHandle: Vec2 | null
  /** Rotation of the box in degrees: a single rotated item shows a rotated box; several items an upright one. */
  rotation: number
}

/** What the renderer and the shell draw. A new object whenever anything in it changed; never mutated. */
export interface BoardUiState {
  doc: BoardDoc
  /** Selected item ids (groups are expanded: every member of a selected group is in here). */
  selection: number[]
  tool: BoardTool
  /** The canvas size in CSS pixels. */
  viewport: { w: number; h: number }
  /** The selection rectangle being dragged, in board units. */
  marquee: Rect | null
  /** Alignment guides while dragging: x positions of vertical lines and y positions of horizontal ones, in board units. */
  guides: { v: number[]; h: number[] }
  box: SelectionBox | null
  /** The mark being drawn (pen, line, rectangle, ellipse), not yet part of the board. */
  draft: BoardItem | null
  /** Id of the note being edited in place, or null. */
  editingNote: number | null
  /** Id of the picture being cropped (crop tool), or null. */
  cropping: number | null
  /** The colour under the pointer in sampler mode (6 hex digits) and where; null when not sampling. */
  sample: { x: number; y: number; hex: string } | null
  /** A CSS cursor name for the pointer's current place. */
  cursor: string
  canUndo: boolean
  canRedo: boolean
  /** What an undo or a redo would take back or apply again ("Move", "Draw" ...), for a menu; null when there is nothing or no label. */
  undoLabel: string | null
  redoLabel: string | null
  /** The board has changed since it was loaded or last saved. */
  dirty: boolean
  /** A pan or zoom in progress (the renderer may draw coarser pictures while it lasts). */
  moving: boolean
  /** Any gesture is held (a drag, a stroke being drawn, a marquee, a pan, a pinch): the session defers an outside reload while it lasts. */
  gesturing: boolean
  /** What new marks and notes are made with, and what the toolbar's colour, width and size controls show. */
  style: BoardStyle
  /** The controller's own clipboard holds items (the paste command has something to paste). */
  canPaste: boolean
  /**
   * How many characters the board's items take in the note (core `boardChars`) and the most a board may grow to
   * (`BOARD_LIMITS.noteTotal`): the status bar's size cell. Growth past the limit is refused; shrinking is always allowed, so `chars`
   * can read above `charsLimit` on a board that was loaded that big. While a drag is under way `chars` is the board's size when it began.
   */
  chars: number
  charsLimit: number
}

/**
 * What the next pen stroke, line, rectangle, ellipse and note are made with. Widths and sizes are CSS pixels as the toolbar shows them:
 * a mark made at zoom z is stored at `px / z` board units, so it looks the same however far the board is zoomed. Changing the style
 * with the select tool active also restyles the selected items that have the property (one undo step).
 */
export interface BoardStyle {
  /** Stroke, line, rectangle and ellipse colour: 6 hex digits, no #. */
  color: string
  /** Line width in CSS pixels. */
  width: number
  /** Rectangle and ellipse fill, or '' for an outline only. */
  fill: string
  /** Note font size in CSS pixels. */
  noteSize: number
  /** Note text colour, or '' for the one that reads on the board's background. */
  noteColor: string
  /** Note background, or '' for none. */
  noteFill: string
  /** Lines get an arrow head. */
  arrow: boolean
}

/** What the controller tells the shell, besides its state: a message, a question only the shell can answer, a job only the shell can do. */
export type BoardEvent =
  /** `code` names the reason where a caller wants to react to it: 'locked' (a locked item refused a change), 'limit' (the board is full), 'select' (the command needs a selection of another kind). */
  | { type: 'toast'; text: string; tone: BoardTone; code?: 'locked' | 'limit' | 'select' }
  /** Sampler: read the canvas pixel at `at` (CSS pixels) and answer with `controller.sampleAt(at, hex)`. */
  | { type: 'sample-request'; at: Vec2 }
  /** Sampler: the user clicked; `hex` is the colour under the pointer (6 digits, no #). The shell copies it and says so. */
  | { type: 'sample-commit'; hex: string }
  /** Extract a palette from these pictures; answer with `controller.addSwatches(colours, near)`; `near` (board units) is a good place for the swatches. */
  | { type: 'palette-request'; ids: number[]; near: Vec2 }
  /** A command only the shell can carry out (it has the host): `ids` and `paths` are the selected items and the distinct paths of the selected pictures. */
  | { type: 'command'; id: BoardCommandId; ids: number[]; paths: string[] }

/* ----------------------------------------------------------- commands ---- */

/**
 * Every action of the board has an id here, a palette command, a help row and (for the common ones) a key. The table
 * BOARD_COMMANDS (commands.ts) lists them all; a test pins that each id is in the table and in docs/KEYBOARD.md.
 */
export type BoardCommandId =
  // tools
  | 'tool.select' | 'tool.hand' | 'tool.note' | 'tool.pen' | 'tool.line' | 'tool.rect' | 'tool.ellipse' | 'tool.eraser' | 'tool.sampler' | 'tool.crop'
  // edit
  | 'edit.undo' | 'edit.redo' | 'edit.selectAll' | 'edit.selectNone' | 'edit.invertSelection' | 'edit.duplicate' | 'edit.delete'
  | 'edit.copy' | 'edit.cut' | 'edit.paste' | 'edit.group' | 'edit.ungroup' | 'edit.lock' | 'edit.unlock'
  // notes: Enter (and F2) on one selected note edits its text
  | 'note.edit'
  // stacking
  | 'order.front' | 'order.forward' | 'order.backward' | 'order.back'
  // transform
  | 'transform.flipH' | 'transform.flipV' | 'transform.rotateCw' | 'transform.rotateCcw' | 'transform.resetRotation'
  | 'transform.resetScale' | 'transform.resetCrop' | 'transform.resetAll'
  // arrange
  | 'arrange.menu' | 'arrange.optimal' | 'arrange.row' | 'arrange.column' | 'arrange.grid' | 'arrange.stack'
  | 'sort.name' | 'sort.added' | 'sort.size' | 'sort.shuffle'
  | 'align.left' | 'align.right' | 'align.top' | 'align.bottom' | 'align.centerH' | 'align.centerV'
  | 'distribute.h' | 'distribute.v'
  | 'normalize.width' | 'normalize.height' | 'normalize.size' | 'normalize.scale'
  // appearance
  | 'view.gray' | 'view.grayItem' | 'view.smooth' | 'view.captions' | 'view.background' | 'view.gridSnap'
  | 'item.opacityUp' | 'item.opacityDown'
  // view
  | 'view.fitAll' | 'view.fitSelection' | 'view.zoom100' | 'view.zoomIn' | 'view.zoomOut' | 'view.hideUi'
  // pictures
  | 'picture.add' | 'picture.open' | 'picture.reveal' | 'picture.showInBrain' | 'picture.info' | 'picture.palette'
  | 'export.selection' | 'export.board'
  // window (desktop)
  | 'window.popOut' | 'window.dock' | 'window.onTop'

export interface BoardCommandInfo {
  id: BoardCommandId
  /** Palette title, prefixed "Board: ". */
  title: string
  group: 'Tools' | 'Edit' | 'Order' | 'Transform' | 'Arrange' | 'Appearance' | 'View' | 'Pictures' | 'Window'
  /** The key as shown in the cheatsheet ("⌘ Z", "⇧ H", "]"), or undefined for a palette-only command. */
  keys?: string
  /** The command needs at least this many items selected (default 0). */
  needs?: number
  /** The command is only offered on the desktop. */
  desktopOnly?: boolean
}

/* ----------------------------------------------------- picture cache ----- */

/** The three sizes a picture is held at, smallest first: 256 and 1024 px (longer side) and the picture itself (capped at 8192 px). */
export const IMAGE_TIERS = [256, 1024, 8192] as const
export type ImageTier = (typeof IMAGE_TIERS)[number]

/** Why a picture cannot be shown: the file is gone, it is more pixels than a board decodes, or it did not decode (or was not readable). */
export type ImageFailure = 'missing' | 'too-large' | 'unreadable'

/** What the renderer draws for a picture right now. */
export interface ImageSlot {
  /** A decoded picture, the best the cache holds for the requested size (maybe a smaller tier than wanted), or null while nothing is loaded. */
  bitmap: ImageBitmap | null
  /** The size of the picture itself in pixels, once known (from any tier), else null. */
  natural: { w: number; h: number } | null
  /** The picture could not be read (missing, too big, broken): draw a placeholder. */
  failed: boolean
  /** Why, when `failed` (a placeholder with no reason is drawn as 'unreadable'). */
  reason?: ImageFailure
}

export interface ImageSource {
  /**
   * The bitmap to draw `path` with when it is `wantPx` device pixels on its longer side, and — as a side effect — starts loading the
   * tier that size needs (and releases nothing). Cheap: called for every visible picture on every frame.
   * `shownPx` is how big the part of the picture that is SHOWN is on the screen (a crop's size, in device pixels): when the cache
   * cannot give every picture the tier it wants, the pictures shown biggest are served first. Default `wantPx`.
   */
  get(path: string, wantPx: number, shownPx?: number): ImageSlot
}

/** The text measuring a canvas gives (real font metrics); the controller falls back to the estimate in @aether/core without one. */
export type BoardTextMetrics = TextMetrics
