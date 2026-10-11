/**
 * The reference board's interaction controller: tools, selection, dragging, drawing, pan and zoom, commands, history and the clipboard,
 * as a state machine with no DOM. The shell (BoardView) feeds it pointer, wheel and key events in the canvas's own CSS pixels and draws
 * `state`; everything else a board needs from a host (saving, pictures, the clipboard of the system) goes through `onChange` and
 * `onEvent`. Design: docs/design/reference-board.md; the types it speaks are in api.ts, the keys in commands.ts.
 *
 * Two documents. `history.current` is the last committed step; `doc` is the live board and runs ahead of it only while a gesture is
 * under way (a drag updates the live board on every move and pushes ONE history step when it ends), while a new note is being typed
 * (it is on the board but in no step until its text is committed, and the savers are never sent it) and after a silent correction
 * (`setNaturalSize`, which the savers are not told of either: it rides the next real edit, like the camera). Every drag
 * recomputes the live board from the board as it was when the drag began, so snapping and constraints are stable and a cancelled drag
 * puts the old board back exactly. The view (pan, zoom) is part of the document but never of a history step: undo keeps the camera
 * where the user left it.
 *
 * Units. Pointers arrive in CSS pixels; the board is in board units; `screenToBoard` turns one into the other. Distances the user
 * feels (a 6 px hit tolerance, a 3 px click, the rotate handle 28 px above the box, a mark's width) are CSS pixels and become
 * `px / zoom` board units. Nothing here is unbounded: strokes are cut to BOARD_LIMITS.strokePoints while they are drawn, the board to
 * BOARD_LIMITS.items and, whatever it holds, to BOARD_LIMITS.noteTotal characters of items (anything that ADDS to it - a mark, a note
 * and its text, pictures, swatches, a paste, a duplicate - past that is refused with the board-is-full message; deleting or shortening
 * is always allowed), notes to BOARD_LIMITS.noteChars, the history to its own limit. What only changes the items that are there (a
 * move, a turn, arranging, a colour, a lock, a group) is never refused: it can change the digits of a coordinate by a few percent (the
 * file keeps two decimals at most), which the room between the budget and the floating window's cap on the whole note absorbs, and
 * "full" would be the wrong thing to tell someone who only locked a picture.
 */
import {
  BOARD_ITEM_LIMITS,
  BOARD_LIMITS,
  History,
  NOTE_PADDING_EM,
  addMark,
  addNote,
  addPicture,
  align,
  arrange,
  boardChars,
  clampDoc,
  clampView,
  cutText,
  distribute,
  duplicateItems,
  emptyBoard,
  estimateTextMetrics,
  expandGroups,
  fitView,
  flipItems,
  group,
  handlesFor,
  hitHandle,
  hitTest,
  insertItems,
  itemBounds,
  itemChars,
  itemQuad,
  itemsBounds,
  itemsInRect,
  lockItems,
  moveItems,
  normalize,
  normalizeAngle,
  panView,
  parseBoard,
  pointInItem,
  removeItems,
  reorder,
  resetCrop,
  resizeNote,
  rotateItems,
  rotatePoint,
  scaleItems,
  screenToBoard,
  serializeBoard,
  setCrop,
  setProps,
  snapMove,
  textColourOn,
  ungroup,
  zoomAt,
  type AlignEdge,
  type ArrangeMode,
  type ArrangeOptions,
  type ArrangeOrder,
  type BoardDoc,
  type BoardItem,
  type BoardPatch,
  type BoardView,
  type HistoryOptions,
  type NormalizeMode,
  type NoteItem,
  type PictureItem,
  type Rect,
  type TextMetrics,
  type Vec2,
} from '@aether/core'
import type { BoardEvent, BoardCommandId, BoardStyle, BoardTool, BoardUiState, HandleKind, KeyIn, PointerIn, SelectionBox, WheelIn } from './api'
import { isRepeatable, keyToCommand } from './commands'

/* ------------------------------------------------------------------ numbers --- */

/** A press that moves less than this (CSS pixels) is a click, not a drag. */
const CLICK_PX = 3
/** How near the pointer must be to an item, in CSS pixels, to hit it. */
const HIT_PX = 6
/** How near to a handle's middle the pointer must be (the handle is 8 px wide), for a mouse or pen and for a finger. */
const HANDLE_HIT_PX = 7
const HANDLE_HIT_TOUCH_PX = 18
/** The rotate handle's distance above the box's top edge, in CSS pixels. */
export const ROTATE_HANDLE_PX = 28
/** How near an edge or centre of another item must be, in CSS pixels, to catch a dragged selection. */
const SNAP_PX = 6
/** A second press within this many milliseconds and CSS pixels of the first is a double click. */
const DOUBLE_MS = 350
const DOUBLE_PX = 6
/** A pen stroke takes a new point when the pointer has moved this far (CSS pixels) from the last one. */
const POINT_SPACING_PX = 1.5
/** The tolerance (CSS pixels) of the Douglas-Peucker pass at the end of a stroke, and where the cap while drawing starts. */
const STROKE_TOLERANCE_PX = 0.5
const ERASER_PX = 8
const WHEEL_BASE = 1.0015
/** A trackpad pinch arrives as ctrl + wheel with small deltas: it is made this much more sensitive. */
const WHEEL_PINCH_BOOST = 3
const WHEEL_LINE_PX = 32
const WHEEL_MAX_FACTOR = 2
const WHEEL_SETTLE_MS = 150
const ZOOM_STEP = 1.25
const FIT_MARGIN_PX = 48
const NUDGE = 1
const NUDGE_BIG = 10
const OPACITY_STEP = 0.1
const DUPLICATE_OFFSET_PX = 24
/** New pictures: the longest side of one is about this share of the viewport's width, and never shown above MAX_ENLARGE times its pixels. */
const PICTURE_SHARE = 0.35
const MAX_ENLARGE = 2
const PICTURE_GAP_PX = 12
const NOTE_WIDTH_PX = 240
const NOTE_MIN_WIDTH_PX = 40
const SWATCH_PX = 14
const SNAP_ANGLE = 15
/** The history keys of the arrow-key nudge, the opacity keys and the style controls: a run of them on one selection is one step. */
const NUDGE_KEY = 'nudge'
const OPACITY_KEY = 'opacity'
const STYLE_KEY = 'style'
const MAX_SWATCHES = 16
/** The eraser looks along a pointer jump at points about its own radius apart, up to this many (a 4,000 px jump is 500 radii). */
const MAX_ERASE_STEPS = 512
/** Room the arrangement of new pictures may take on top of what they measured when added (coordinates get longer digits). */
const ARRANGE_SLACK_CHARS = 32
/** What a picture's line takes in the note, as far as `pictureRoom` can tell before the picture has a name: a path of some 80 characters and its numbers. */
const PICTURE_LINE_CHARS = 160
/** Why a board takes no more pictures, as the toast words it. */
const WHY_ITEMS = `it holds at most ${BOARD_LIMITS.items} items`
const WHY_CHARS = `it holds at most about ${BOARD_LIMITS.noteTotal.toLocaleString('en-US')} characters of items`
/** A copy for the system clipboard: its first line, and the most text a paste will read (twice the board's budget). */
const COPY_HEAD = /^Aether Brain board: (\d+) items? copied\r?\n/
const MAX_COPY_CHARS = 2 * BOARD_LIMITS.noteTotal
/** Pictures' own sizes remembered (the oldest are forgotten past it) and pointers followed at once (a pointer that never lifted is dropped). */
const MAX_NATURALS = 4096
const MAX_POINTERS = 32

/** The backgrounds `view.background` steps through. */
export const BOARD_BACKGROUNDS: readonly { readonly name: string; readonly hex: string }[] = Object.freeze([
  Object.freeze({ name: 'dark', hex: '14161d' }),
  Object.freeze({ name: 'mid grey', hex: '808080' }),
  Object.freeze({ name: 'light grey', hex: 'd6d6d6' }),
  Object.freeze({ name: 'black', hex: '000000' }),
  Object.freeze({ name: 'white', hex: 'ffffff' }),
])

export const DEFAULT_STYLE: Readonly<BoardStyle> = Object.freeze({
  color: 'ff5a36',
  width: 3,
  fill: '',
  noteSize: 18,
  noteColor: '',
  noteFill: '',
  arrow: false,
})

const NO_GUIDES: BoardUiState['guides'] = Object.freeze({
  v: Object.freeze([]) as unknown as number[],
  h: Object.freeze([]) as unknown as number[],
})
const HEX6 = /^[0-9a-fA-F]{6}$/

/* ---------------------------------------------------------------- the API --- */

export interface BoardChangeWhy {
  /** What happened, for logs and tests ("move", "pan", "command:edit.delete" ...). */
  reason: string
  /** The change is complete: a gesture ended or a one-shot command ran. False while a drag is under way. */
  final: boolean
  /** Only the view moved (pan, zoom): the board is not dirty and need not be saved. */
  viewOnly: boolean
}

export interface BoardControllerOptions {
  doc: BoardDoc
  /** How tall notes are; the estimate of @aether/core until the shell has the canvas's real font metrics. */
  metrics?: TextMetrics
  /** The clock history coalescing runs on (milliseconds). Tests supply it; Date.now otherwise. */
  now?: () => number
  history?: HistoryOptions
  /** The canvas size in CSS pixels until `setViewport` says; 800 by 600. */
  viewport?: { w: number; h: number }
}

type StateListener = (state: BoardUiState) => void
type ChangeListener = (doc: BoardDoc, why: BoardChangeWhy) => void
type EventListener_ = (e: BoardEvent) => void

/* ----------------------------------------------------------- pure helpers --- */

function fin(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function hex6(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.startsWith('#') ? v.slice(1) : v
  return HEX6.test(s) ? s.toLowerCase() : null
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function rectFrom(a: Vec2, b: Vec2): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Deep equality of plain data (numbers, strings, booleans, arrays, plain objects): enough to tell a board from its echo. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  for (const k of ka) if (!(k in rb) || !deepEqual(ra[k], rb[k])) return false
  return true
}

/** Whether two boards differ in anything but the view: the view is the camera, not the work. */
function differs(a: BoardDoc, b: BoardDoc): boolean {
  return (
    a.items !== b.items ||
    a.extra !== b.extra ||
    a.title !== b.title ||
    a.bg !== b.bg ||
    a.gray !== b.gray ||
    a.smooth !== b.smooth ||
    a.captions !== b.captions ||
    a.grid !== b.grid ||
    a.nextId !== b.nextId
  )
}

/**
 * Whether two boards hold the same work: the same items in the same order and the same settings, whatever their ids (a board read from
 * a note numbers its items 1, 2, 3 ..., one that was edited has gaps) and however their groups are numbered, and whatever the camera.
 */
function sameBoard(a: BoardDoc, b: BoardDoc): boolean {
  if (a === b) return true
  if (a.items.length !== b.items.length) return false
  if (!deepEqual({ ...a, items: 0, view: 0, nextId: 0 }, { ...b, items: 0, view: 0, nextId: 0 })) return false
  const labelsA = new Map<number, number>()
  const labelsB = new Map<number, number>()
  const label = (m: Map<number, number>, g: number): number => {
    if (!(g > 0)) return 0
    let v = m.get(g)
    if (v === undefined) {
      v = m.size + 1
      m.set(g, v)
    }
    return v
  }
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i]!
    const y = b.items[i]!
    if (!deepEqual({ ...x, id: 0, group: label(labelsA, x.group) }, { ...y, id: 0, group: label(labelsB, y.group) })) return false
  }
  return true
}

/** The doc with the view of `view` (the same object when it already has it). */
function withView(doc: BoardDoc, view: BoardView): BoardDoc {
  return doc.view === view ? doc : { ...doc, view }
}

function isMark(item: BoardItem): boolean {
  return item.kind === 'stroke' || item.kind === 'line' || item.kind === 'rect' || item.kind === 'ellipse'
}

function isLaidOut(item: BoardItem): boolean {
  return item.kind === 'picture' || item.kind === 'note'
}

/** The part of the segment a to b inside the rectangle, as the range of t (0 at a, 1 at b) it covers, or null when it misses it. */
function clipSegment(a: Vec2, b: Vec2, r: Rect): { t0: number; t1: number } | null {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return null
      if (t > t0) t0 = t
    } else {
      if (t < t0) return null
      if (t < t1) t1 = t
    }
  }
  return { t0, t1 }
}

/**
 * The most characters the text box of a note may hold: the creation limit, or the length the note already has when it was opened
 * (a longer text from a file is kept up to BOARD_LIMITS.noteCharsFile, as core's `setProps` keeps it). Editing never shortens a text
 * by itself, and typing can make it shorter again but not longer than it was. The text box, the draft and the commit all use this.
 */
export function noteCap(currentText: string): number {
  return Math.min(BOARD_LIMITS.noteCharsFile, Math.max(BOARD_LIMITS.noteChars, currentText.length))
}

function segmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? clampTo(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0
  const qx = ax + t * dx - px
  const qy = ay + t * dy - py
  return qx * qx + qy * qy
}

/**
 * Douglas-Peucker on a polyline given as x0, y0, x1, y1 ...: the points that matter, within `tolerance` of the full line, ends always
 * kept. Iterative (a long stroke would run a recursion dry). Exported for the tests.
 */
export function simplifyStroke(points: readonly number[], tolerance: number): number[] {
  const n = points.length >> 1
  if (n <= 2 || !(tolerance > 0)) return points.slice(0, n * 2)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const tol2 = tolerance * tolerance
  const stack: number[] = [0, n - 1]
  while (stack.length > 0) {
    const hi = stack.pop()!
    const lo = stack.pop()!
    if (hi <= lo + 1) continue
    let best = -1
    let bestD = tol2
    const ax = points[2 * lo]!
    const ay = points[2 * lo + 1]!
    const bx = points[2 * hi]!
    const by = points[2 * hi + 1]!
    for (let i = lo + 1; i < hi; i++) {
      const d = segmentDistSq(points[2 * i]!, points[2 * i + 1]!, ax, ay, bx, by)
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push(lo, best, best, hi)
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[2 * i]!, points[2 * i + 1]!)
  return out
}

/** `points` brought to at most `cap` points: simplified with a growing tolerance, then thinned if that is not enough. Ends are kept. */
function capStroke(points: readonly number[], cap: number, tolerance: number): number[] {
  if (points.length >> 1 <= cap) return points.slice()
  let out = points.slice()
  let tol = Math.max(tolerance, 1e-6)
  // Cut to three quarters so the next points have room and the pass is not repeated on every pointer move.
  const target = Math.max(2, Math.floor(cap * 0.75))
  for (let i = 0; i < 32 && out.length >> 1 > target; i++) {
    out = simplifyStroke(points, tol)
    tol *= 2
  }
  if (out.length >> 1 > cap) {
    // Simplifying could not get there (a stroke of many far-apart points): an even subsample, first and last point kept.
    const n = out.length >> 1
    const sample: number[] = []
    for (let k = 0; k < target; k++) {
      const i = Math.round((k * (n - 1)) / (target - 1))
      sample.push(out[2 * i]!, out[2 * i + 1]!)
    }
    out = sample
  }
  return out
}

type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'

/** Which way a handle lies from the middle of the box: -1, 0 or 1 across and down. */
function handleDirection(h: Exclude<BoxHandle, 'rotate'>): readonly [number, number] {
  switch (h) {
    case 'nw':
      return [-1, -1]
    case 'n':
      return [0, -1]
    case 'ne':
      return [1, -1]
    case 'e':
      return [1, 0]
    case 'se':
      return [1, 1]
    case 's':
      return [0, 1]
    case 'sw':
      return [-1, 1]
    case 'w':
      return [-1, 0]
  }
}

/** The resize cursor a handle gets, turned with the box so a corner of a tilted picture points along its diagonal. */
function resizeCursor(h: Exclude<BoxHandle, 'rotate'>, rotation: number): string {
  const [hx, hy] = handleDirection(h)
  const angle = ((((Math.atan2(hy, hx) * 180) / Math.PI + rotation) % 180) + 180) % 180
  switch (Math.round(angle / 45) % 4) {
    case 0:
      return 'ew-resize'
    case 1:
      return 'nwse-resize'
    case 2:
      return 'ns-resize'
    default:
      return 'nesw-resize'
  }
}

/* ---------------------------------------------------------------- gestures --- */

interface Tracked {
  x: number
  y: number
  type: PointerIn['pointerType']
}

interface GestureBase {
  pointer: number
  /** Where the press was, in CSS pixels and in board units. */
  startScreen: Vec2
  start: Vec2
  /** The live board when the gesture began: a drag recomputes from it, a cancel puts it back. */
  base: BoardDoc
}

interface PanGesture extends GestureBase {
  kind: 'pan'
  last: Vec2
  /** A finger on the empty canvas: the pan stands in for the marquee, so a tap that did not move clears the selection like a click. */
  tap: boolean
  moved: boolean
}

interface MarqueeGesture extends GestureBase {
  kind: 'marquee'
  /** The selection when the press began, restored on cancel and kept when the marquee adds to it. */
  before: number[]
  additive: boolean
  active: boolean
}

interface MoveGesture extends GestureBase {
  kind: 'move'
  ids: number[]
  active: boolean
  /** The item pressed, to narrow the selection to it when the press turns out a click. */
  clickId: number
  /** Shift or Ctrl was down at the press: the press adds to the selection and a click on a selected item takes it out. */
  additive: boolean
  /** The item pressed was already selected: with `additive`, a click takes it out, a drag still moves. */
  toggleOff: boolean
}

interface ScaleGesture extends GestureBase {
  kind: 'scale'
  handle: Exclude<BoxHandle, 'rotate'>
  box: SelectionBox
  /** Where the press was, from the handle's middle, in the box's own turned frame: the handle follows the pointer without a jump. */
  grab: Vec2
  ids: number[]
  /** The lone note whose side handles change its width, else null. */
  note: number | null
}

interface RotateGesture extends GestureBase {
  kind: 'rotate'
  ids: number[]
  pivot: Vec2
  lastAngle: number
  /** The angle turned so far, kept continuous past a half turn. */
  total: number
  /** The rotation of the lone picture or note being turned, so Shift can snap its own angle; null for anything else. */
  r0: number | null
}

interface CropGesture extends GestureBase {
  kind: 'crop'
  handle: Exclude<BoxHandle, 'rotate'>
  pic: PictureItem
  /** Where the press was, from the handle's middle, in the picture's own turned frame. */
  grab: Vec2
}

interface DrawGesture extends GestureBase {
  kind: 'draw'
  tool: 'pen' | 'line' | 'rect' | 'ellipse'
  /** The stroke's points so far (pen only). */
  pts: number[]
  lastScreen: Vec2
  pressureSum: number
  pressureN: number
  pen: boolean
  /** Shift and Alt as the last move had them: the mark that is committed is the one the draft showed, whatever the release says. */
  mods: { shift: boolean; alt: boolean }
}

interface EraseGesture extends GestureBase {
  kind: 'erase'
  last: Vec2
  bounds: Map<number, Rect>
  /** The selection when the press began: the marks come back with a cancel, and selected again. */
  before: number[]
}

interface NoteGesture extends GestureBase {
  kind: 'note'
  active: boolean
}

interface SampleGesture extends GestureBase {
  kind: 'sample'
}

type Gesture =
  | PanGesture
  | MarqueeGesture
  | MoveGesture
  | ScaleGesture
  | RotateGesture
  | CropGesture
  | DrawGesture
  | EraseGesture
  | NoteGesture
  | SampleGesture

interface Pinch {
  a: number
  b: number
  mid: Vec2
  dist: number
}

/** What the outbox holds until the end of a public call: a change for the savers or an event for the shell. */
type Outgoing = { kind: 'change'; doc: BoardDoc; why: BoardChangeWhy } | { kind: 'event'; event: BoardEvent }

interface CommitOptions {
  /** A note being edited stays being edited (a colour changed while typing). */
  keepEditing?: boolean
  key?: string
  reason?: string
  /** The selection afterwards; the old one (kept by id) when left out. */
  select?: readonly number[]
}

/* -------------------------------------------------------------- controller --- */

export class BoardController {
  private doc: BoardDoc
  private readonly metrics: TextMetrics
  private readonly clock: () => number
  private readonly hist: History<BoardDoc>
  /** The history step that was last saved (or loaded): the board is clean while it is current. */
  private savedAt: BoardDoc

  private selection: number[] = []
  private tool: BoardTool = 'select'
  private viewport: { w: number; h: number }
  private marquee: Rect | null = null
  private guides: BoardUiState['guides'] = NO_GUIDES
  private draft: BoardItem | null = null
  private editingNote: number | null = null
  /** The note being typed that is on the board but in no history step yet. */
  private pendingNote: number | null = null
  private cropping: number | null = null
  private sample: BoardUiState['sample'] = null
  private sampleCommit = false
  private style: BoardStyle = { ...DEFAULT_STYLE }
  private clipboard: BoardItem[] = []
  private pasteCount = 0
  private shuffles = 0
  /** Pictures' own sizes by path; `exact` is false for the shape of a preview, which is not the picture's pixel size. */
  private readonly naturals = new Map<string, { w: number; h: number; exact: boolean }>()
  /** The last copy or cut stored items (nothing selected, or only locked items, stores none): what `exportCopy` hands out. */
  private copyStored = false
  /** Where the last paste from the system clipboard landed and how many in a row landed there (a cascade, like paste). */
  private lastImport: { x: number; y: number; n: number } | null = null
  /** The grid size to come back to when snapping is switched on again. */
  private lastGrid = 16
  /** The items of the live board when a silent correction of shapes is all that separates it from the last step (see `noteSilent`). */
  private silentItems: readonly BoardItem[] | null = null

  private readonly pointers = new Map<number, Tracked>()
  /** Pointers whose gesture was cancelled or cut short: ignored until they lift. */
  private readonly ignored = new Set<number>()
  private gesture: Gesture | null = null
  private pinch: Pinch | null = null
  private space = false
  private lastClick: { time: number; x: number; y: number } | null = null
  private hover: Vec2 | null = null
  private hoverType: PointerIn['pointerType'] = 'mouse'
  /** The cursor depends on the selection or the tool, which changed: it is worked out again at the next flush. */
  private rehover = false
  private hoverHandle: HandleKind | null = null
  private hoverOnSelection = false
  private wheelMoving = false
  private wheelTimer: ReturnType<typeof setTimeout> | null = null

  private cache: BoardUiState | null = null
  private stateChanged = false
  private flushing = false
  private outbox: Outgoing[] = []
  private readonly stateListeners = new Set<StateListener>()
  private readonly changeListeners = new Set<ChangeListener>()
  private readonly eventListeners = new Set<EventListener_>()

  constructor(opts: BoardControllerOptions) {
    this.metrics = opts.metrics ?? estimateTextMetrics
    this.clock = opts.now ?? (() => Date.now())
    this.doc = clampDoc(opts.doc)
    if (this.doc.grid > 0) this.lastGrid = this.doc.grid
    this.hist = new History<BoardDoc>(opts.history)
    this.hist.reset(this.doc)
    this.savedAt = this.doc
    const vp = opts.viewport
    this.viewport = vp && vp.w > 0 && vp.h > 0 ? { w: vp.w, h: vp.h } : { w: 800, h: 600 }
  }

  /* ------------------------------------------------------------ observers --- */

  /** What to draw: a new object whenever anything in it changed, never mutated. */
  get state(): BoardUiState {
    if (!this.cache) this.cache = this.build()
    return this.cache
  }

  /** Called with the new state after every public call that changed it. Returns the unsubscribe. */
  subscribe(cb: StateListener): () => void {
    this.stateListeners.add(cb)
    return () => void this.stateListeners.delete(cb)
  }

  /**
   * Called when the board (not only its view) changed, for saving: `final` is true at the end of a gesture and for a one-shot command
   * (save now), false while a drag is under way (save at most once in a while); `viewOnly` is true for a pan or zoom, which does not
   * make the board dirty. Returns the unsubscribe.
   */
  onChange(cb: ChangeListener): () => void {
    this.changeListeners.add(cb)
    return () => void this.changeListeners.delete(cb)
  }

  /** Messages and requests for the shell (see BoardEvent). Returns the unsubscribe. */
  onEvent(cb: EventListener_): () => void {
    this.eventListeners.add(cb)
    return () => void this.eventListeners.delete(cb)
  }

  /** Stops the timers and forgets the listeners. */
  dispose(): void {
    if (this.wheelTimer !== null) clearTimeout(this.wheelTimer)
    this.wheelTimer = null
    this.stateListeners.clear()
    this.changeListeners.clear()
    this.eventListeners.clear()
  }

  /* ------------------------------------------------------------- plumbing --- */

  private touch(): void {
    this.cache = null
    this.stateChanged = true
  }

  private changed(reason: string, final: boolean, viewOnly = false): void {
    this.touch()
    this.outbox.push({ kind: 'change', doc: this.emittable(), why: { reason, final, viewOnly } })
  }

  /** The board as the savers hear of it: a note still being typed is in no step and not in the file, so it is not in what is sent. */
  private emittable(): BoardDoc {
    return this.pendingNote === null ? this.doc : removeItems(this.doc, [this.pendingNote])
  }

  private emit(event: BoardEvent): void {
    this.outbox.push({ kind: 'event', event })
  }

  private toast(text: string, tone: 'info' | 'success' | 'error' = 'info', code?: 'locked' | 'limit' | 'select'): void {
    this.emit(code ? { type: 'toast', text, tone, code } : { type: 'toast', text, tone })
  }

  private toastLocked(): void {
    this.toast('Locked items cannot be changed. Unlock them first.', 'info', 'locked')
  }

  /**
   * Whether the board `next` may replace the present one in an operation that adds to it: it fits the character budget
   * (`BOARD_LIMITS.noteTotal`, measured by core's `boardChars`), or it is no bigger than the board is now (a board that was loaded
   * over the budget can still be edited and thinned, never grown).
   */
  private fits(next: BoardDoc): boolean {
    const after = boardChars(next)
    return after <= BOARD_LIMITS.noteTotal || after <= boardChars(this.doc)
  }

  private refuseBudget(): void {
    const n = this.doc.items.length
    this.toast(
      `The board is full: it holds at most about ${BOARD_LIMITS.noteTotal.toLocaleString('en-US')} characters of items (${n} item${n === 1 ? '' : 's'}).`,
      'error',
      'limit',
    )
  }

  private toastItemsFull(): void {
    this.toast(`The board is full: it holds at most ${BOARD_LIMITS.items} items.`, 'error', 'limit')
  }

  /**
   * Hands what happened to the listeners, after the call that caused it has finished its work (a listener may call straight back in:
   * the shell answers a sample request from inside its event). A listener that throws does not stop the others.
   */
  private flush(): void {
    if (this.flushing) return
    // The selection or the tool changed under a pointer that is not moving: the cursor is worked out again where it stands.
    if (this.rehover) {
      this.rehover = false
      if (!this.gesture && this.tool !== 'sampler') this.updateHover()
    }
    this.flushing = true
    let failure: unknown = null
    try {
      for (let rounds = 0; rounds < 64 && (this.stateChanged || this.outbox.length > 0); rounds++) {
        const out = this.outbox
        this.outbox = []
        if (this.stateChanged) {
          this.stateChanged = false
          // The state is built when someone asks for it; with nobody listening there is nothing to build.
          if (this.stateListeners.size > 0) {
            const s = this.state
            for (const cb of [...this.stateListeners]) {
              try {
                cb(s)
              } catch (err) {
                failure ??= err
              }
            }
          }
        }
        for (const o of out) {
          if (o.kind === 'change') {
            for (const cb of [...this.changeListeners]) {
              try {
                cb(o.doc, o.why)
              } catch (err) {
                failure ??= err
              }
            }
          } else {
            for (const cb of [...this.eventListeners]) {
              try {
                cb(o.event)
              } catch (err) {
                failure ??= err
              }
            }
          }
        }
      }
    } finally {
      this.flushing = false
    }
    if (failure !== null) throw failure
  }

  private get zoom(): number {
    return this.doc.view.zoom
  }

  private toBoard(p: Vec2): Vec2 {
    return screenToBoard(this.doc.view, this.viewport, p)
  }

  private itemById(id: number): BoardItem | undefined {
    return this.doc.items.find((it) => it.id === id)
  }

  private selectedItems(): BoardItem[] {
    const set = new Set(this.selection)
    return this.doc.items.filter((it) => set.has(it.id))
  }

  private allSelectionLocked(): boolean {
    const items = this.selectedItems()
    return items.length > 0 && items.every((it) => it.locked)
  }

  /** The selection, kept to ids that are on the board, whole groups, in board order. */
  private setSelection(ids: readonly number[]): void {
    const next = expandGroups(this.doc, ids)
    if (sameIds(next, this.selection)) return
    this.selection = next
    this.rehover = true
    this.touch()
  }

  /** After the board changed under the selection, the note or the crop: drop what is gone. */
  private reconcile(): void {
    const next = expandGroups(this.doc, this.selection)
    if (!sameIds(next, this.selection)) {
      this.selection = next
      this.rehover = true
    }
    if (this.editingNote !== null && !this.itemById(this.editingNote)) {
      this.editingNote = null
      this.pendingNote = null
    }
    if (this.cropping !== null && this.itemById(this.cropping)?.kind !== 'picture') this.leaveCrop()
    this.touch()
  }

  private leaveCrop(): void {
    this.cropping = null
    if (this.tool === 'crop') this.tool = 'select'
    this.touch()
  }

  /** The live board with the view of the moment: gestures recompute from an older board and must not carry its camera back. */
  private setLive(next: BoardDoc): void {
    this.doc = withView(next, this.doc.view)
    this.touch()
  }

  /** A step of a drag: the live board becomes `next`, and the savers hear of it only when it really differs. */
  private live(next: BoardDoc, reason: string): void {
    const before = this.doc
    this.setLive(next)
    if (differs(this.doc, before)) this.changed(reason, false)
  }

  /** Makes `next` the board and pushes it as one history step. */
  private commit(next: BoardDoc, label: string, o: CommitOptions = {}): void {
    // A note being typed is in no step until its text is committed: an operation computed on the board that holds it must not take it along.
    const pending = this.pendingNote
    if (!o.keepEditing) this.cancelEditing()
    if (pending !== null && !o.keepEditing && this.itemIn(next, pending)) next = removeItems(next, [pending])
    this.doc = withView(next, this.doc.view)
    const step = pending !== null && o.keepEditing && this.itemIn(this.doc, pending) ? withView(removeItems(this.doc, [pending]), this.doc.view) : this.doc
    this.hist.push(step, { label, key: o.key, now: this.clock() })
    if (o.select) this.selection = expandGroups(this.doc, o.select)
    this.reconcile()
    this.changed(o.reason ?? label.toLowerCase(), true)
  }

  private itemIn(doc: BoardDoc, id: number): boolean {
    return doc.items.some((it) => it.id === id)
  }

  /** Runs an operation on the selection and commits it; false (with a toast for a locked selection) when it changed nothing. */
  private edit(label: string, fn: (doc: BoardDoc) => BoardDoc, o: CommitOptions = {}): boolean {
    if (this.selection.length === 0) return false
    const next = fn(this.doc)
    if (next === this.doc) {
      if (this.allSelectionLocked()) this.toastLocked()
      return false
    }
    this.commit(next, label, o)
    return true
  }

  /** A history key for a run of small changes: the run is one step only while it is on the same selection. */
  private runKey(base: string): string {
    return `${base}:${this.selection.join(',')}`
  }

  private isDirty(): boolean {
    if (this.hist.current !== this.savedAt) return true
    const step = this.hist.current
    if (!differs(this.doc, step)) return false
    // Ahead of the last step by a silent correction of shapes only (the user did nothing): the work is as it was saved.
    return !(this.silentItems === this.doc.items && !differs({ ...this.doc, items: step.items }, step))
  }

  /**
   * After the live board was put to the last step plus the corrected shapes (a size arrived, an undo, a cancel): remembers which items
   * those are, so that the board still counts as saved when a correction is all that separates it from the last step. With a drag under
   * way or a note being typed the board is ahead of its step for real, and nothing is remembered.
   */
  private noteSilent(): void {
    this.silentItems = this.gesture === null && this.pendingNote === null && this.doc.items !== this.hist.current.items ? this.doc.items : null
  }

  /** The live board back to the last history step, with the shapes the controller has learned since (a note being typed is gone). */
  private restoreStep(): void {
    this.doc = this.fixAspects(withView(this.hist.current, this.doc.view))
    this.noteSilent()
  }

  /**
   * A key or a style change meets a gesture that rewrites the board from the board as it was when the gesture began (a drag, a scale, a
   * turn, a crop, a stroke being erased): the gesture is cancelled first, as for a command, so that what follows is ONE step on the board
   * as it was, not a step on a half-made drag that the drag then overwrites. A pan only moves the camera and carries on.
   */
  private settleGesture(): void {
    if (this.gesture && this.gesture.kind !== 'pan') this.cancelGesture()
  }

  /** The note being typed is dropped when something else wants to change the board (the shell should commit or cancel it first). */
  private cancelEditing(): void {
    if (this.editingNote === null) return
    const pending = this.pendingNote !== null
    this.editingNote = null
    this.pendingNote = null
    if (pending) this.restoreStep()
    this.reconcile()
  }

  /* --------------------------------------------------------------- state --- */

  private computeBox(): SelectionBox | null {
    if (this.cropping !== null || this.editingNote !== null || this.selection.length === 0) return null
    if (this.tool !== 'select' && this.tool !== 'hand') return null
    const items = this.selectedItems()
    const hb = handlesFor(items, this.metrics, ROTATE_HANDLE_PX / this.zoom)
    return hb ? { corners: hb.corners, rotateHandle: hb.rotateHandle, rotation: hb.rotation } : null
  }

  private cursorName(): string {
    const g = this.gesture
    if (g) {
      switch (g.kind) {
        case 'pan':
          return 'grabbing'
        case 'move':
          return g.active ? 'move' : 'default'
        case 'scale':
          return resizeCursor(g.handle, g.box.rotation)
        case 'crop':
          return resizeCursor(g.handle, g.pic.rotation)
        case 'rotate':
          return 'crosshair'
        case 'erase':
          return 'cell'
        case 'draw':
        case 'sample':
          return 'crosshair'
        case 'note':
          return 'text'
        case 'marquee':
          return 'default'
      }
    }
    if (this.space) return 'grab'
    switch (this.tool) {
      case 'hand':
        return 'grab'
      case 'note':
        return 'text'
      case 'pen':
      case 'line':
      case 'rect':
      case 'ellipse':
      case 'sampler':
        return 'crosshair'
      case 'eraser':
        return 'cell'
      case 'crop':
      case 'select': {
        const h = this.hoverHandle
        if (h === null) return this.hoverOnSelection ? 'move' : 'default'
        if (h === 'rotate') return 'crosshair'
        if (h === 'body') return 'move'
        const name = (h.startsWith('crop-') ? h.slice(5) : h) as Exclude<BoxHandle, 'rotate'>
        const cropped = this.tool === 'crop' && this.cropping !== null ? this.itemById(this.cropping) : undefined
        const rotation = cropped?.kind === 'picture' ? cropped.rotation : (this.computeBox()?.rotation ?? 0)
        return resizeCursor(name, rotation)
      }
    }
  }

  /** A pan, a zoom or a drag that moves things is under way: the renderer may draw coarser pictures meanwhile. */
  private isMoving(): boolean {
    if (this.wheelMoving || this.pinch !== null) return true
    const g = this.gesture
    if (!g) return false
    switch (g.kind) {
      case 'pan':
      case 'scale':
      case 'rotate':
      case 'crop':
        return true
      case 'move':
        return g.active
      default:
        return false
    }
  }

  private build(): BoardUiState {
    return {
      doc: this.doc,
      selection: this.selection,
      tool: this.tool,
      viewport: this.viewport,
      marquee: this.marquee,
      guides: this.guides,
      box: this.computeBox(),
      draft: this.draft,
      editingNote: this.editingNote,
      cropping: this.cropping,
      sample: this.sample,
      cursor: this.cursorName(),
      canUndo: this.hist.canUndo,
      canRedo: this.hist.canRedo,
      undoLabel: this.hist.undoLabel,
      redoLabel: this.hist.redoLabel,
      dirty: this.isDirty(),
      moving: this.isMoving(),
      gesturing: this.gesture !== null || this.pinch !== null,
      style: this.style,
      canPaste: this.clipboard.length > 0,
      chars: this.charsNow(),
      charsLimit: BOARD_LIMITS.noteTotal,
    }
  }

  /**
   * The size of the board in the note, as core counts it (each item's line is counted once, whatever the number of states built). A drag
   * is shown at the size the board had when it began: it adds nothing, and counting the moved items again on every pointer move would
   * mean writing out every line of them.
   */
  private charsNow(): number {
    const g = this.gesture
    return boardChars(g ? withView(g.base, this.doc.view) : this.doc)
  }

  /* ------------------------------------------------------ outside changes --- */

  /** The canvas size in CSS pixels. */
  setViewport(w: number, h: number): void {
    if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return
    if (w === this.viewport.w && h === this.viewport.h) return
    this.viewport = { w, h }
    this.touch()
    this.flush()
  }

  /** Puts the camera somewhere (a remembered view): a view-only change, no history. */
  setView(view: BoardView): void {
    if (this.setViewDoc(view)) this.changed('view', true, true)
    this.flush()
  }

  private setViewDoc(view: BoardView): boolean {
    const v = clampView(view)
    const cur = this.doc.view
    if (v.x === cur.x && v.y === cur.y && v.zoom === cur.zoom) return false
    this.doc = { ...this.doc, view: v }
    this.touch()
    return true
  }

  /**
   * The board changed somewhere else (an editor, an AI, another window): take it. A board that holds the same work as the present one
   * (the echo of this controller's own save, a rewrite of the prose or the line endings round the board) changes nothing, and is judged
   * BEFORE anything is cancelled: a stroke being drawn, a drag or a note being typed goes on. A board that differs ends the gesture and
   * the typing, replaces the board, and is a BARRIER: the history starts again from it (an undo must not take back what another
   * program wrote and save the older board over it), the camera is kept, the new board counts as saved, and the selection stays only
   * on items that are exactly what they were (ids are numbered by position in the note, so a line inserted above shifts every id below
   * it). Pass `view: true` to take the new board's view too (first load).
   */
  replaceDoc(doc: BoardDoc, opts: { view?: boolean } = {}): void {
    let next = clampDoc(doc)
    if (!opts.view) next = withView(next, this.doc.view)
    next = this.fixAspects(next)
    if (sameBoard(next, this.gesture ? this.gesture.base : this.emittable())) {
      if (opts.view) this.setViewDoc(next.view)
      this.flush()
      return
    }
    this.cancelGesture()
    this.cancelEditing()
    const was = this.doc
    const identical = (id: number): boolean => {
      const a = was.items.find((it) => it.id === id)
      const b = next.items.find((it) => it.id === id)
      return a !== undefined && b !== undefined && deepEqual(a, b)
    }
    this.selection = this.selection.filter(identical)
    if (this.cropping !== null && !identical(this.cropping)) this.leaveCrop()
    this.doc = next
    this.hist.reset(next)
    this.silentItems = null
    this.savedAt = this.hist.current
    if (next.grid > 0) this.lastGrid = next.grid
    this.rehover = true
    this.reconcile()
    this.touch()
    this.flush()
  }

  /** The board was saved: it is clean until something changes. */
  markSaved(): void {
    this.savedAt = this.hist.current
    this.touch()
    this.flush()
  }

  /* --------------------------------------------------------------- style --- */

  /**
   * Changes what new marks and notes are made with. With the select tool active, the selected items that have the property take it too
   * (one undo step, a run of changes from a colour dragger is one step). Values that are not valid are ignored.
   */
  setStyle(patch: Partial<BoardStyle>): void {
    const next: BoardStyle = { ...this.style }
    // What was valid in the patch: only that restyles the selection, a bad value changes nothing anywhere.
    const taken: Partial<BoardStyle> = {}
    const colour = (v: unknown, allowNone: boolean): string | null => (allowNone && v === '' ? '' : hex6(v))
    const color = colour(patch.color, false)
    if (color !== null) taken.color = color
    const fill = colour(patch.fill, true)
    if (fill !== null) taken.fill = fill
    const noteColor = colour(patch.noteColor, true)
    if (noteColor !== null) taken.noteColor = noteColor
    const noteFill = colour(patch.noteFill, true)
    if (noteFill !== null) taken.noteFill = noteFill
    if (typeof patch.width === 'number' && Number.isFinite(patch.width)) taken.width = clampTo(patch.width, 0.5, 200)
    if (typeof patch.noteSize === 'number' && Number.isFinite(patch.noteSize)) taken.noteSize = clampTo(patch.noteSize, 6, 400)
    if (typeof patch.arrow === 'boolean') taken.arrow = patch.arrow
    Object.assign(next, taken)
    const same = (Object.keys(next) as (keyof BoardStyle)[]).every((k) => next[k] === this.style[k])
    if (!same) {
      this.style = next
      this.touch()
    }
    if (this.pendingNote !== null) this.restylePending(taken, next)
    else if (this.tool === 'select' && this.selection.length > 0) this.restyleSelection(taken, next)
    this.flush()
  }

  /** The note being typed takes the note styles in place: it is in no history step yet, and its own commit carries them. */
  private restylePending(patch: Partial<BoardStyle>, style: BoardStyle): void {
    const id = this.pendingNote
    if (id === null) return
    const p: BoardPatch = {}
    if (patch.noteSize !== undefined) p.size = style.noteSize / this.zoom
    if (patch.noteColor !== undefined && style.noteColor !== '') p.color = style.noteColor
    if (patch.noteFill !== undefined) p.fill = style.noteFill
    if (Object.keys(p).length === 0) return
    const doc = setProps(this.doc, [id], p, this.metrics)
    if (doc === this.doc) return
    this.doc = doc
    this.touch()
  }

  private restyleSelection(patch: Partial<BoardStyle>, style: BoardStyle): void {
    if (Object.keys(patch).length === 0) return
    const targets = (): { marks: number[]; notes: number[] } => {
      const items = this.selectedItems().filter((it) => !it.locked)
      return { marks: items.filter(isMark).map((it) => it.id), notes: items.filter((it) => it.kind === 'note').map((it) => it.id) }
    }
    if (targets().marks.length + targets().notes.length === 0) return
    // A drag in progress ends first: the restyle is one step on the board as it was, not on a half-made drag that carries on.
    this.settleGesture()
    const { marks, notes } = targets()
    const px = 1 / this.zoom
    let doc = this.doc
    if (marks.length > 0) {
      const p: BoardPatch = {}
      if (patch.color !== undefined) p.color = style.color
      if (patch.width !== undefined) p.width = style.width * px
      if (patch.fill !== undefined) p.fill = style.fill
      if (patch.arrow !== undefined) p.arrow = style.arrow
      doc = setProps(doc, marks, p, this.metrics)
    }
    if (notes.length > 0) {
      const p: BoardPatch = {}
      if (patch.noteSize !== undefined) p.size = style.noteSize * px
      if (patch.noteColor !== undefined && style.noteColor !== '') p.color = style.noteColor
      if (patch.noteFill !== undefined) p.fill = style.noteFill
      doc = setProps(doc, notes, p, this.metrics)
    }
    if (doc !== this.doc) this.commit(doc, 'Style', { key: this.runKey(STYLE_KEY), reason: 'style', keepEditing: true })
  }

  /* ------------------------------------------------------------- pictures --- */

  /**
   * Adds pictures to the board, on top, shown at a sensible size and laid out as the 'optimal' arrangement round `at` (the middle of
   * the view when left out), selected, as one history step. `w`, `h` are each picture's own pixel size, or the shape of a preview of
   * it: `exact` says it is the picture's own (the controller then knows it for Reset size and 100%; it learns the rest from
   * `setNaturalSize`). The longest side of a picture is about 35% of the viewport's width and never more than twice its own pixels on
   * the screen. Past BOARD_LIMITS.items or the character budget the rest are left out and the user is told. Returns the new ids.
   */
  addPictures(items: readonly { path: string; w: number; h: number; exact?: boolean }[], at?: Vec2): number[] {
    this.cancelGesture()
    this.cancelEditing()
    const given = items.filter((it) => typeof it.path === 'string' && it.path !== '')
    if (given.length === 0) {
      this.flush()
      return []
    }
    const room = BOARD_LIMITS.items - this.doc.items.length
    if (room <= 0) {
      this.toastItemsFull()
      this.flush()
      return []
    }
    const take = given.slice(0, room)
    const zoom = this.zoom
    const view = this.doc.view
    const centre = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : { x: view.x, y: view.y }
    let doc = this.doc
    const ids: number[] = []
    let chars = boardChars(doc)
    let overBudget = false
    for (const it of take) {
      const known = Number.isFinite(it.w) && Number.isFinite(it.h) && it.w > 0 && it.h > 0
      const nw = known ? it.w : 1
      const nh = known ? it.h : 1
      const longest = Math.max(nw, nh)
      const wanted = (PICTURE_SHARE * this.viewport.w) / zoom
      // A picture of unknown size has no pixels to limit it: it gets the share (its shape is a square until the real size arrives).
      const shown = known ? Math.min(wanted, (MAX_ENLARGE * longest) / zoom) : wanted
      const s = shown / longest
      const res = addPicture(doc, { path: it.path, w: nw * s, h: nh * s, x: centre.x, y: centre.y })
      if (res.id === null) continue
      // The arrangement below rewrites the coordinates with longer digits: a little room is kept for it.
      const made = res.doc.items[res.doc.items.length - 1]
      const grown = chars + (made ? itemChars(made) : 0) + ARRANGE_SLACK_CHARS
      if (grown > BOARD_LIMITS.noteTotal) {
        overBudget = true
        break
      }
      chars = grown
      doc = res.doc
      ids.push(res.id)
      if (known) this.rememberNatural(it.path, it.w, it.h, it.exact === true)
    }
    if (ids.length === 0) {
      if (overBudget) this.refuseBudget()
      this.flush()
      return []
    }
    const aspect = clampTo(this.viewport.w / this.viewport.h, 0.5, 3)
    doc = arrange(doc, ids, 'optimal', { metrics: this.metrics, gap: PICTURE_GAP_PX / zoom, aspect })
    if (!this.fits(doc)) {
      this.refuseBudget()
      this.flush()
      return []
    }
    this.commit(doc, 'Add pictures', { select: ids, reason: 'pictures' })
    if (ids.length < given.length) {
      this.toast(`The board is full: added ${ids.length} of ${given.length} pictures (${overBudget ? WHY_CHARS : WHY_ITEMS}).`, 'error', 'limit')
    }
    this.flush()
    return ids
  }

  /**
   * How many pictures `addPictures` can take now, judged before the pictures exist (so before they are copied anywhere): by the item
   * limit exactly, by the character budget at an estimate of a picture's line plus the room an arrangement may take. `addPictures`
   * stays the judge of what really fits. `why` words the limit that is met first, as the "board is full" message does.
   */
  pictureRoom(): { room: number; why: string } {
    const byItems = BOARD_LIMITS.items - this.doc.items.length
    const byChars = Math.floor((BOARD_LIMITS.noteTotal - boardChars(this.doc)) / (PICTURE_LINE_CHARS + ARRANGE_SLACK_CHARS))
    return { room: Math.max(0, Math.min(byItems, byChars)), why: byItems <= byChars ? WHY_ITEMS : WHY_CHARS }
  }

  /**
   * A picture's real size arrived (from decoding it): every picture of that path whose shape differs from it by more than 1% takes
   * the real shape, keeping its width. Silent: no history step, no toast, and NOT a change of the board for the savers (a board that is
   * only looked at is never written): the corrected shape is kept in memory and goes into the note with the next real edit, as the
   * camera does. A drag in progress is corrected too (its base is what every step is made from). History states (undo) are corrected
   * the same way when they come back.
   */
  setNaturalSize(path: string, w: number, h: number): void {
    if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return
    this.rememberNatural(path, w, h, true)
    const next = this.fixAspects(this.doc)
    const g = this.gesture
    if (g) {
      // The same set of items stays the same set (a gesture that has changed nothing yet must not look changed).
      g.base = g.base.items === this.doc.items ? withView(next, g.base.view) : this.fixAspects(g.base)
      if (g.kind === 'crop') {
        const pic = g.base.items.find((it) => it.id === g.pic.id)
        if (pic?.kind === 'picture') g.pic = pic
      }
    }
    if (next !== this.doc) {
      this.doc = next
      this.noteSilent()
      this.changed('natural-size', false, true)
    }
    this.flush()
  }

  private rememberNatural(path: string, w: number, h: number, exact: boolean): void {
    const old = this.naturals.get(path)
    // A shape taken from a preview never replaces the picture's own size.
    if (old?.exact && !exact) return
    // Re-inserting moves the path to the newest end of the map, which is where the forgetting starts from the other side.
    this.naturals.delete(path)
    this.naturals.set(path, { w, h, exact })
    if (this.naturals.size > MAX_NATURALS) {
      const oldest = this.naturals.keys().next()
      if (!oldest.done) this.naturals.delete(oldest.value)
    }
  }

  private fixAspects(doc: BoardDoc): BoardDoc {
    if (this.naturals.size === 0) return doc
    let items: BoardItem[] | null = null
    const fixed: number[] = []
    for (let i = 0; i < doc.items.length; i++) {
      const it = doc.items[i]!
      if (it.kind !== 'picture') continue
      const nat = this.naturals.get(it.path)
      if (!nat) continue
      const want = nat.w / nat.h
      if (!(it.h > 0) || Math.abs(it.w / it.h / want - 1) <= 0.01) continue
      items ??= doc.items.slice()
      items[i] = { ...it, h: it.w / want }
      fixed.push(i)
    }
    if (!items) return doc
    const next = clampDoc({ ...doc, items })
    // A shape the size limits would put back (a very long thin picture) is no correction: the picture stays the very same object.
    let kept: BoardItem[] | null = null
    for (const i of fixed) {
      const before = doc.items[i]!
      const after = next.items[i]!
      if (before.kind === 'picture' && after.kind === 'picture' && before.w === after.w && before.h === after.h) {
        kept ??= next.items.slice()
        kept[i] = before
      }
    }
    if (!kept) return next
    return kept.every((it, i) => it === doc.items[i]) ? doc : { ...next, items: kept }
  }

  /** The pictures' own sizes the controller knows (a shape taken from a preview is among them: see `exactNaturalSize`), or null. */
  naturalSize(path: string): { w: number; h: number } | null {
    const n = this.naturals.get(path)
    return n ? { w: n.w, h: n.h } : null
  }

  /** The picture's size in pixels when the controller knows it for sure (from decoding the picture itself), else null. */
  exactNaturalSize(path: string): { w: number; h: number } | null {
    const n = this.naturals.get(path)
    return n?.exact ? { w: n.w, h: n.h } : null
  }

  /**
   * Adds colour swatches (small notes filled with each colour, labelled with its hex, in a row centred on `near`, top edge at
   * `near.y`), selected, one history step. The answer to a 'palette-request'.
   */
  addSwatches(colours: readonly string[], near: Vec2): number[] {
    this.cancelGesture()
    this.cancelEditing()
    const list: string[] = []
    for (const c of colours) {
      const h = hex6(c)
      if (h && !list.includes(h) && list.length < MAX_SWATCHES) list.push(h)
    }
    const room = BOARD_LIMITS.items - this.doc.items.length
    if (list.length === 0 || !Number.isFinite(near.x) || !Number.isFinite(near.y)) {
      this.flush()
      return []
    }
    if (room < list.length) {
      this.toastItemsFull()
      this.flush()
      return []
    }
    const size = clampTo(SWATCH_PX / this.zoom, BOARD_ITEM_LIMITS.noteSize.min, BOARD_ITEM_LIMITS.noteSize.max)
    const w = size * 6
    const gap = size * 0.5
    const pad = NOTE_PADDING_EM * size
    const h = this.metrics.layout('#000000', size, Math.max(w - 2 * pad, 1)).height + 2 * pad
    const total = list.length * w + (list.length - 1) * gap
    let doc = this.doc
    const ids: number[] = []
    list.forEach((hex, i) => {
      const res = addNote(doc, {
        text: '#' + hex,
        x: near.x - total / 2 + w / 2 + i * (w + gap),
        y: near.y + h / 2,
        w,
        size,
        color: textColourOn(hex),
        fill: hex,
      })
      doc = res.doc
      if (res.id !== null) ids.push(res.id)
    })
    if (!this.fits(doc)) {
      this.refuseBudget()
      this.flush()
      return []
    }
    this.commit(doc, 'Add colours', { select: ids, reason: 'swatches' })
    this.flush()
    return ids
  }

  /* ---------------------------------------------------------------- notes --- */

  /**
   * Makes a note whose top-left corner is `p` and starts editing it. The note is on the board but in no history step until
   * `commitNoteText` gives it text (an empty one is never kept). Returns its id, 0 when the board is full.
   */
  addNoteAt(p: Vec2): number {
    const id = this.makeNote(p.x, p.y, NOTE_WIDTH_PX / this.zoom)
    this.flush()
    return id
  }

  private makeNote(left: number, top: number, width: number): number {
    this.cancelGesture()
    this.cancelEditing()
    if (this.doc.items.length >= BOARD_LIMITS.items) {
      this.toastItemsFull()
      return 0
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return 0
    const size = clampTo(this.style.noteSize / this.zoom, BOARD_ITEM_LIMITS.noteSize.min, BOARD_ITEM_LIMITS.noteSize.max)
    const w = clampTo(width, BOARD_ITEM_LIMITS.noteWidth.min, BOARD_ITEM_LIMITS.noteWidth.max)
    const pad = NOTE_PADDING_EM * size
    const h = this.metrics.layout('', size, Math.max(w - 2 * pad, 1)).height + 2 * pad
    const res = addNote(this.doc, {
      text: '',
      x: left + w / 2,
      y: top + h / 2,
      w,
      size,
      color: this.style.noteColor,
      fill: this.style.noteFill,
    })
    if (res.id === null) return 0
    if (!this.fits(res.doc)) {
      this.refuseBudget()
      return 0
    }
    this.doc = withView(res.doc, this.doc.view)
    this.pendingNote = res.id
    this.editingNote = res.id
    this.selection = [res.id]
    this.rehover = true
    if (this.tool === 'note') this.tool = 'select'
    this.touch()
    return res.id
  }

  /** Starts editing the text of an existing note (the context menu's "Edit"). */
  editNote(id: number): void {
    this.beginEdit(id)
    this.flush()
  }

  private beginEdit(id: number): void {
    const it = this.itemById(id)
    if (it?.kind !== 'note') return
    if (it.locked) {
      this.toastLocked()
      return
    }
    // Already being edited: starting again must not drop the note that is being typed (a new one is in no history step yet).
    if (this.editingNote === id) return
    this.cancelGesture()
    this.cancelEditing()
    this.editingNote = id
    this.selection = expandGroups(this.doc, [id])
    this.rehover = true
    this.touch()
  }

  /**
   * Gives a note its text: one history step (a new note's step adds it). Text is cut to `noteCap` (BOARD_LIMITS.noteChars, or the length
   * a longer note from a file already has: opening such a note and leaving it as it is changes nothing, no step and no save); text that
   * is empty or only white space deletes the note. Ends editing, except when the text would take the board past its character budget: that is
   * refused with a message, and the note stays open to be shortened (shrinking a note is always allowed).
   */
  commitNoteText(id: number, text: string): void {
    const note = this.itemById(id)
    const wasEditing = this.editingNote === id
    const pending = this.pendingNote === id
    if (note?.kind !== 'note') {
      if (wasEditing) this.editingNote = null
      if (pending) this.pendingNote = null
      this.touch()
      this.flush()
      return
    }
    const clean = cutText(String(text), noteCap(note.text))
    const grown = !note.locked && clean.trim() !== '' && (pending || clean !== note.text) ? setProps(this.doc, [id], { text: clean }, this.metrics) : null
    if (grown && !this.fits(grown)) {
      this.refuseBudget()
      this.touch()
      this.flush()
      return
    }
    if (wasEditing) this.editingNote = null
    if (pending) this.pendingNote = null
    if (note.locked) {
      this.toastLocked()
    } else if (clean.trim() === '') {
      // An empty note is not worth keeping. One that was only being typed leaves no trace at all.
      if (pending) this.restoreStep()
      else this.commit(removeItems(this.doc, [id]), 'Delete note', { reason: 'note' })
      this.reconcile()
    } else if (grown && pending) {
      this.commit(grown, 'Add note', { reason: 'note', select: [id] })
    } else if (grown) {
      this.commit(grown, 'Edit note', { reason: 'note' })
    }
    this.touch()
    this.flush()
  }

  /** Leaves editing without changing anything: a new note that was never given text is gone again. */
  cancelNoteEdit(): void {
    this.cancelEditing()
    this.touch()
    this.flush()
  }

  /* -------------------------------------------------------------- sampler --- */

  /** The shell's answer to a 'sample-request': the colour at `p` (CSS pixels), or null when there is none (outside the canvas). */
  sampleAt(p: Vec2, hex: string | null): void {
    if (this.tool !== 'sampler') return
    const h = hex === null ? null : hex6(hex)
    if (h === null) {
      this.sample = null
      this.sampleCommit = false
    } else {
      this.sample = { x: p.x, y: p.y, hex: h }
      if (this.sampleCommit) {
        this.sampleCommit = false
        this.emit({ type: 'sample-commit', hex: h })
      }
    }
    this.touch()
    this.flush()
  }

  /* ---------------------------------------------------------------- tools --- */

  private setTool(tool: BoardTool): void {
    if (tool === this.tool && !(tool === 'crop' && this.cropping === null)) return
    if (tool === 'crop') {
      const pics = this.selectedItems().filter((it): it is PictureItem => it.kind === 'picture')
      if (pics.length !== 1) {
        this.tool = 'crop'
        this.cropping = null
        this.toast('Click the picture you want to crop.', 'info', 'select')
      } else if (pics[0]!.locked) {
        this.toastLocked()
        return
      } else {
        this.tool = 'crop'
        this.cropping = pics[0]!.id
      }
    } else {
      if (this.cropping !== null) this.cropping = null
      this.tool = tool
    }
    this.sample = null
    this.sampleCommit = false
    this.hoverHandle = null
    this.hoverOnSelection = false
    this.rehover = true
    this.touch()
  }

  /* -------------------------------------------------------------- pointer --- */

  pointerDown(e: PointerIn): void {
    this.handleDown(e)
    this.flush()
  }

  private handleDown(e: PointerIn): void {
    if (this.editingNote !== null) return
    // Where the pointer is, for the cursor to be worked out against when the selection or the tool changes under it.
    this.hover = { x: e.x, y: e.y }
    this.hoverType = e.pointerType
    const stale = this.pointers.get(e.id)
    // A press for a pointer we think is still down: its release was lost. The old press ends where it was last seen.
    if (stale) {
      this.handleUp({ ...e, x: stale.x, y: stale.y }, false)
      // That press may have started a note: the text box has the board now, and this press is not for the canvas.
      if (this.editingNote !== null) return
    }
    this.ignored.delete(e.id)
    // Pointers that never lifted (their release was lost) are forgotten rather than followed for ever.
    if (this.pointers.size >= MAX_POINTERS) this.dropPointers()
    if (e.pointerType === 'touch') {
      const others = [...this.pointers.entries()].filter(([, t]) => t.type === 'touch')
      if (others.length >= 1) {
        this.pointers.set(e.id, { x: e.x, y: e.y, type: 'touch' })
        // Fingers never take a stroke or a drag from a pen or a mouse: two palm contacts beside a pen are not a pinch.
        const owner = this.gesture ? this.pointers.get(this.gesture.pointer) : undefined
        if (owner && owner.type !== 'touch') this.ignored.add(e.id)
        else if (others.length === 1 && this.pinch === null) this.startPinch(others[0]![0], e)
        else this.ignored.add(e.id)
        return
      }
    }
    this.pointers.set(e.id, { x: e.x, y: e.y, type: e.pointerType })
    // One gesture at a time: a second pointer (a pen beside the mouse, a third finger) waits for its turn. A pen is the exception to
    // a finger's gesture: a palm resting on the glass starts a stroke (or a pinch) of its own, and the pen must still draw.
    if (e.pointerType === 'pen' && this.pinch !== null) {
      this.ignored.add(this.pinch.a)
      this.ignored.add(this.pinch.b)
      this.pinch = null
      this.touch()
    }
    if (this.gesture) {
      if (e.pointerType === 'pen' && this.pointers.get(this.gesture.pointer)?.type === 'touch') this.cancelGesture()
      else {
        this.ignored.add(e.id)
        return
      }
    }
    this.sampleCommit = false
    const s = { x: e.x, y: e.y }
    // The eraser end of a pen (button 5, or the eraser bit of `buttons`) rubs out whatever tool is chosen, for as long as it is down.
    if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)) {
      const p = this.toBoard(s)
      this.startErase(e, p)
      return
    }
    const panning =
      e.button === 1 || (e.button === 0 && (this.space || this.tool === 'hand')) || (e.button === 2 && e.pointerType === 'pen')
    if (panning) {
      this.startGesture({ kind: 'pan', pointer: e.id, startScreen: s, start: this.toBoard(s), base: this.doc, last: s, tap: false, moved: true })
      return
    }
    if (e.button === 2) {
      // A right click starts nothing (the shell shows its menu) but the item under it becomes the selection if it is not in it.
      const hit = this.hitAt(this.toBoard(s))
      if (hit && !this.selection.includes(hit.id)) this.setSelection([hit.id])
      this.ignored.add(e.id)
      return
    }
    if (e.button !== 0) {
      this.ignored.add(e.id)
      return
    }
    const p = this.toBoard(s)
    switch (this.tool) {
      case 'select':
        this.downSelect(e, p)
        break
      case 'note':
        if (this.refuseWhenFull()) return
        this.startGesture({ kind: 'note', pointer: e.id, startScreen: s, start: p, base: this.doc, active: false })
        break
      case 'pen':
      case 'line':
      case 'rect':
      case 'ellipse':
        if (this.refuseWhenFull()) return
        this.downDraw(e, p, this.tool)
        break
      case 'eraser':
        this.startErase(e, p)
        break
      case 'sampler':
        this.startGesture({ kind: 'sample', pointer: e.id, startScreen: s, start: p, base: this.doc })
        this.emit({ type: 'sample-request', at: s })
        break
      case 'crop':
        this.downCrop(e, p)
        break
      case 'hand':
        break
    }
  }

  private startErase(e: PointerIn, p: Vec2): void {
    this.startGesture({
      kind: 'erase',
      pointer: e.id,
      startScreen: { x: e.x, y: e.y },
      start: p,
      base: this.doc,
      last: p,
      bounds: new Map(),
      before: this.selection,
    })
    this.eraseTo(p, p)
  }

  /** A press that would add something (a mark, a note) on a board that has no room: refused up front, not after the drawing. */
  private refuseWhenFull(): boolean {
    if (this.doc.items.length >= BOARD_LIMITS.items) {
      this.toastItemsFull()
      return true
    }
    if (boardChars(this.doc) >= BOARD_LIMITS.noteTotal) {
      this.refuseBudget()
      return true
    }
    return false
  }

  private startGesture(g: Gesture): void {
    this.gesture = g
    this.touch()
  }

  private hitAt(p: Vec2): BoardItem | null {
    return hitTest(this.doc, p, HIT_PX / this.zoom, this.metrics)
  }

  /** The handle of the selection box (or of the crop frame) the pointer is on, or null. */
  private handleAt(s: Vec2, type: PointerIn['pointerType']): HandleKind | null {
    const tol = (type === 'touch' ? HANDLE_HIT_TOUCH_PX : HANDLE_HIT_PX) / this.zoom
    const p = this.toBoard(s)
    if (this.tool === 'crop') {
      const pic = this.cropping === null ? undefined : this.itemById(this.cropping)
      if (pic?.kind !== 'picture') return null
      const h = hitHandle({ corners: itemQuad(pic, this.metrics), rotateHandle: null }, p, tol)
      return h && h !== 'rotate' ? (`crop-${h}` as HandleKind) : null
    }
    if (this.tool !== 'select') return null
    const box = this.computeBox()
    if (!box) return null
    // Nothing can be done with the handles of a selection that is all locked: a press near them is a press on the canvas.
    if (this.allSelectionLocked()) return null
    // A box smaller than its own handles is all handle: the zones shrink to the outer thirds so that the middle still moves it.
    const wPx = dist(box.corners[0], box.corners[1]) * this.zoom
    const hPx = dist(box.corners[0], box.corners[3]) * this.zoom
    const grab = type === 'touch' ? HANDLE_HIT_TOUCH_PX : HANDLE_HIT_PX
    const reach = wPx < 2 * grab && hPx < 2 * grab ? Math.max(2, Math.min(wPx, hPx) / 3) / this.zoom : tol
    let h = hitHandle(box, p, Math.min(tol, reach))
    // The rotate handle floats clear of the box and keeps its full reach.
    if (!h && reach < tol && hitHandle(box, p, tol) === 'rotate') h = 'rotate'
    if (!h) return null
    const items = this.selectedItems()
    // A note's height follows its text: only its sides change it.
    if (items.length === 1 && items[0]!.kind === 'note' && (h === 'n' || h === 's')) return null
    return h
  }

  private downSelect(e: PointerIn, p: Vec2): void {
    const s = { x: e.x, y: e.y }
    const handle = this.handleAt(s, e.pointerType)
    if (handle && handle !== 'body' && !handle.startsWith('crop-')) {
      this.startHandle(e, p, handle as BoxHandle)
      return
    }
    const hit = this.hitAt(p)
    if (this.takeDouble(e, p, hit)) return
    this.lastClick = { time: e.time, x: e.x, y: e.y }
    const additive = e.shift || e.ctrl || e.meta
    if (hit) {
      let toggleOff = false
      const selected = this.selection.includes(hit.id)
      if (additive) {
        if (selected) toggleOff = true
        else this.setSelection([...this.selection, hit.id])
      } else if (!selected) {
        this.setSelection([hit.id])
      }
      this.startGesture({
        kind: 'move',
        pointer: e.id,
        startScreen: s,
        start: p,
        base: this.doc,
        ids: this.selection,
        active: false,
        clickId: hit.id,
        additive,
        toggleOff,
      })
      return
    }
    if (e.pointerType === 'touch') {
      const tap = !(e.shift || e.ctrl || e.meta)
      this.startGesture({ kind: 'pan', pointer: e.id, startScreen: s, start: p, base: this.doc, last: s, tap, moved: false })
      return
    }
    const additiveMarquee = e.shift || e.ctrl || e.meta
    this.startGesture({
      kind: 'marquee',
      pointer: e.id,
      startScreen: s,
      start: p,
      base: this.doc,
      before: this.selection,
      additive: additiveMarquee,
      active: false,
    })
  }

  /** A second press close to the first in time and place: edit a note, fit a picture, or start a note on empty canvas. */
  private takeDouble(e: PointerIn, p: Vec2, hit: BoardItem | null): boolean {
    const lc = this.lastClick
    if (!lc || e.time < lc.time || e.time - lc.time > DOUBLE_MS || Math.hypot(e.x - lc.x, e.y - lc.y) > DOUBLE_PX) return false
    if (hit && hit.kind !== 'note' && hit.kind !== 'picture') return false
    this.lastClick = null
    this.ignored.add(e.id)
    if (hit?.kind === 'note') {
      this.setSelection([hit.id])
      if (hit.locked) this.toastLocked()
      else {
        this.editingNote = hit.id
        this.touch()
      }
    } else if (hit?.kind === 'picture') {
      this.setSelection([hit.id])
      this.fitTo(itemBounds(hit, this.metrics))
    } else {
      this.makeNote(p.x, p.y, NOTE_WIDTH_PX / this.zoom)
    }
    return true
  }

  private startHandle(e: PointerIn, p: Vec2, handle: BoxHandle): void {
    const box = this.computeBox()
    if (!box) return
    const s = { x: e.x, y: e.y }
    if (this.allSelectionLocked()) {
      this.toastLocked()
      this.ignored.add(e.id)
      return
    }
    const items = this.selectedItems()
    const base: GestureBase = { pointer: e.id, startScreen: s, start: p, base: this.doc }
    if (handle === 'rotate') {
      const pivot = mid(box.corners[0], box.corners[2])
      const lone = items.length === 1 && (items[0]!.kind === 'picture' || items[0]!.kind === 'note') ? items[0]! : null
      this.startGesture({
        ...base,
        kind: 'rotate',
        ids: this.selection,
        pivot,
        lastAngle: (Math.atan2(p.y - pivot.y, p.x - pivot.x) * 180) / Math.PI,
        total: 0,
        r0: lone ? (lone as PictureItem | NoteItem).rotation : null,
      })
      return
    }
    const note = items.length === 1 && items[0]!.kind === 'note' ? items[0]!.id : null
    const centre = mid(box.corners[0], box.corners[2])
    const [hx, hy] = handleDirection(handle)
    const pressed = rotatePoint(p, centre, -box.rotation)
    const grab = {
      x: pressed.x - centre.x - (hx * dist(box.corners[0], box.corners[1])) / 2,
      y: pressed.y - centre.y - (hy * dist(box.corners[0], box.corners[3])) / 2,
    }
    this.startGesture({ ...base, kind: 'scale', handle, box, grab, ids: this.selection, note })
  }

  private downDraw(e: PointerIn, p: Vec2, tool: DrawGesture['tool']): void {
    const s = { x: e.x, y: e.y }
    const pen = e.pointerType === 'pen'
    const g: DrawGesture = {
      kind: 'draw',
      tool,
      pointer: e.id,
      startScreen: s,
      start: p,
      base: this.doc,
      pts: tool === 'pen' ? [p.x, p.y] : [],
      lastScreen: s,
      pressureSum: pen ? this.pressureOf(e) : 0.5,
      pressureN: 1,
      pen,
      mods: { shift: e.shift, alt: e.alt },
    }
    this.gesture = g
    // A stroke of one point is no stroke (a tap leaves nothing): nothing is drawn for it until a second point arrives.
    this.draft = tool === 'pen' ? null : this.makeDraft(g, p, e)
    this.touch()
  }

  private pressureOf(e: PointerIn): number {
    // A pen that reports no pressure counts as a mouse: half.
    return Number.isFinite(e.pressure) && e.pressure > 0 ? clampTo(e.pressure, 0, 1) : 0.5
  }

  private downCrop(e: PointerIn, p: Vec2): void {
    const s = { x: e.x, y: e.y }
    const handle = this.handleAt(s, e.pointerType)
    if (handle && handle.startsWith('crop-') && this.cropping !== null) {
      const pic = this.itemById(this.cropping)
      if (pic?.kind !== 'picture') return
      if (pic.locked) {
        this.toastLocked()
        this.ignored.add(e.id)
        return
      }
      const name = handle.slice(5) as Exclude<BoxHandle, 'rotate'>
      const [hx, hy] = handleDirection(name)
      const pressed = rotatePoint(p, { x: pic.x, y: pic.y }, -pic.rotation)
      const grab = {
        x: pressed.x - pic.x - (hx * (pic.crop.r - pic.crop.l) * pic.w) / 2,
        y: pressed.y - pic.y - (hy * (pic.crop.b - pic.crop.t) * pic.h) / 2,
      }
      this.startGesture({ kind: 'crop', pointer: e.id, startScreen: s, start: p, base: this.doc, handle: name, pic, grab })
      return
    }
    const hit = this.hitAt(p)
    if (hit?.kind === 'picture') {
      if (hit.locked) {
        this.toastLocked()
        return
      }
      this.cropping = hit.id
      this.setSelection([hit.id])
      this.touch()
    }
  }

  pointerMove(e: PointerIn): void {
    this.handleMove(e)
    this.flush()
  }

  private handleMove(e: PointerIn): void {
    const tracked = this.pointers.get(e.id)
    if (!tracked) {
      this.hoverMove(e)
      return
    }
    // A button let go outside the window and no up arrived: the press is over.
    if (e.buttons === 0) {
      this.handleUp(e, false)
      this.hoverMove(e)
      return
    }
    tracked.x = e.x
    tracked.y = e.y
    if (this.pinch && (this.pinch.a === e.id || this.pinch.b === e.id)) {
      this.pinchMove()
      return
    }
    const g = this.gesture
    if (!g || g.pointer !== e.id || this.ignored.has(e.id)) return
    const s = { x: e.x, y: e.y }
    const p = this.toBoard(s)
    switch (g.kind) {
      case 'pan':
        if (!g.moved && dist(s, g.startScreen) >= CLICK_PX) g.moved = true
        this.panBy(s.x - g.last.x, s.y - g.last.y)
        g.last = s
        break
      case 'marquee':
        this.marqueeMove(g, s, p)
        break
      case 'move':
        this.moveMove(g, s, p, e)
        break
      case 'scale':
        this.live(this.scaleTo(g, p, e.alt), 'scale')
        break
      case 'rotate':
        this.rotateMove(g, p, e.shift)
        break
      case 'crop':
        this.live(this.cropTo(g, p), 'crop')
        break
      case 'draw':
        this.drawMove(g, s, p, e)
        break
      case 'erase':
        this.eraseTo(g.last, p)
        g.last = p
        break
      case 'note':
        if (!g.active && dist(s, g.startScreen) >= CLICK_PX) g.active = true
        if (g.active) {
          this.draft = {
            kind: 'rect',
            id: 0,
            group: 0,
            locked: false,
            x1: g.start.x,
            y1: g.start.y,
            x2: p.x,
            y2: p.y,
            color: this.style.color,
            width: 1 / this.zoom,
            fill: '',
          }
          this.touch()
        }
        break
      case 'sample':
        this.emit({ type: 'sample-request', at: s })
        break
    }
  }

  /** The pointer moved with no button down: the cursor, the sampler. */
  private hoverMove(e: PointerIn): void {
    this.hover = { x: e.x, y: e.y }
    this.hoverType = e.pointerType
    this.rehover = false
    this.updateHover()
  }

  /** The cursor for the pointer where it was last seen: the handle it is on, or whether it is on the selection. */
  private updateHover(): void {
    const at = this.hover
    if (!at) return
    if (this.tool === 'sampler') {
      this.emit({ type: 'sample-request', at: { x: at.x, y: at.y } })
      return
    }
    let handle: HandleKind | null = null
    let onSelection = false
    if (this.tool === 'select' || this.tool === 'crop') {
      handle = this.handleAt(at, this.hoverType)
      // Only a selected item changes the cursor: with nothing selected the hit test would be for nothing.
      if (handle === null && this.tool === 'select' && this.selection.length > 0) {
        const hit = this.hitAt(this.toBoard(at))
        onSelection = hit !== null && this.selection.includes(hit.id)
      }
    }
    if (handle !== this.hoverHandle || onSelection !== this.hoverOnSelection) {
      this.hoverHandle = handle
      this.hoverOnSelection = onSelection
      this.touch()
    }
  }

  /** The canvas or the window lost the focus: a key let go meanwhile (Space) would never be heard of, so none is held any more. */
  blur(): void {
    if (this.space) {
      this.space = false
      this.touch()
    }
    this.flush()
  }

  /**
   * Drops every pointer held, ends any gesture (the board is put back as it was before it began, a stroke half drawn is gone) and
   * forgets a pinch and the pointers being ignored. For when a release will never arrive: the window lost the focus mid-drag, the canvas
   * lost its pointer capture, a touch was taken by the system. Nothing is committed.
   */
  cancelPointers(): void {
    this.dropPointers()
    this.flush()
  }

  private dropPointers(): void {
    this.cancelGesture()
    this.pointers.clear()
    this.ignored.clear()
    this.pinch = null
    this.lastClick = null
    this.touch()
  }

  /** The pointer left the canvas: no hover, no loupe. */
  pointerLeave(): void {
    this.hover = null
    if (this.hoverHandle !== null || this.hoverOnSelection || this.sample !== null) {
      this.hoverHandle = null
      this.hoverOnSelection = false
      if (this.tool === 'sampler') this.sample = null
      this.touch()
    }
    this.flush()
  }

  pointerUp(e: PointerIn): void {
    this.handleUp(e, false)
    this.flush()
  }

  pointerCancel(e: PointerIn): void {
    this.handleUp(e, true)
    this.flush()
  }

  private handleUp(e: PointerIn, cancelled: boolean): void {
    this.hover = { x: e.x, y: e.y }
    this.hoverType = e.pointerType
    const wasTracked = this.pointers.delete(e.id)
    const wasIgnored = this.ignored.delete(e.id)
    if (!wasTracked) return
    if (this.pinch && (this.pinch.a === e.id || this.pinch.b === e.id)) {
      const other = this.pinch.a === e.id ? this.pinch.b : this.pinch.a
      this.pinch = null
      // The finger left on the glass does not turn into a pan or a drag halfway through.
      if (this.pointers.has(other)) this.ignored.add(other)
      this.changed('zoom', true, true)
      return
    }
    if (wasIgnored) return
    const g = this.gesture
    if (!g || g.pointer !== e.id) return
    if (cancelled) {
      this.cancelGesture()
      return
    }
    const s = { x: e.x, y: e.y }
    this.finishGesture(g, s, this.toBoard(s), e)
  }

  private endGesture(): void {
    this.rehover = true
    this.gesture = null
    this.marquee = null
    this.draft = null
    this.guides = NO_GUIDES
    this.noteSilent()
    this.touch()
  }

  /** Puts the board, the selection and the drafts back as they were when the gesture began. */
  private cancelGesture(): void {
    const g = this.gesture
    if (!g) return
    // The pointer may still be down: it is ignored until it lifts (a pointer that is already up leaves nothing behind).
    if (this.pointers.has(g.pointer)) this.ignored.add(g.pointer)
    const hadChange = differs(this.doc, withView(g.base, this.doc.view))
    if (g.kind === 'marquee') this.setSelection(g.before)
    if (g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate' || g.kind === 'crop' || g.kind === 'erase') {
      this.doc = withView(g.base, this.doc.view)
      this.reconcile()
    }
    // The marks an eraser took out come back selected, as they were.
    if (g.kind === 'erase') this.setSelection(g.before)
    this.endGesture()
    if (hadChange) this.changed('cancel', true)
  }

  private finishGesture(g: Gesture, s: Vec2, p: Vec2, e: PointerIn): void {
    switch (g.kind) {
      case 'pan':
        if (g.tap && !g.moved) this.setSelection([])
        else this.changed('pan', true, true)
        break
      case 'marquee':
        if (!g.active && !g.additive) this.setSelection([])
        break
      case 'move':
        if (!g.active) {
          if (g.toggleOff) {
            const drop = new Set(expandGroups(this.doc, [g.clickId]))
            this.setSelection(this.selection.filter((id) => !drop.has(id)))
          } else if (this.selection.length > 1 && !g.additive) {
            this.setSelection([g.clickId])
          }
        } else this.commitGesture(g, 'Move', 'move')
        break
      case 'scale':
        this.commitGesture(g, g.note !== null && (g.handle === 'e' || g.handle === 'w') ? 'Resize note' : 'Scale', 'scale')
        break
      case 'rotate':
        this.commitGesture(g, 'Rotate', 'rotate')
        break
      case 'crop':
        this.commitGesture(g, 'Crop', 'crop')
        break
      case 'draw':
        this.finishDraw(g, s, p)
        break
      case 'erase':
        this.commitGesture(g, 'Erase', 'erase')
        break
      case 'note':
        this.finishNote(g, p)
        break
      case 'sample': {
        const at = this.sample
        if (at && Math.hypot(at.x - s.x, at.y - s.y) <= 2) this.emit({ type: 'sample-commit', hex: at.hex })
        else {
          this.sampleCommit = true
          this.emit({ type: 'sample-request', at: s })
        }
        break
      }
    }
    this.endGesture()
  }

  /** The end of a drag that changes the board: one history step when it changed anything. */
  private commitGesture(g: Gesture, label: string, reason: string): void {
    if (differs(this.doc, g.base)) this.commit(this.doc, label, { reason })
  }

  /* ------------------------------------------------------------ gestures --- */

  private panBy(dx: number, dy: number): void {
    if (this.setViewDoc(panView(this.doc.view, dx, dy))) this.changed('pan', false, true)
  }

  private marqueeMove(g: MarqueeGesture, s: Vec2, p: Vec2): void {
    if (!g.active && dist(s, g.startScreen) < CLICK_PX) return
    g.active = true
    this.lastClick = null
    const rect = rectFrom(g.start, p)
    this.marquee = rect
    const hit = itemsInRect(this.doc, rect, 'touch', this.metrics)
    this.setSelection(g.additive ? [...g.before, ...hit] : hit)
    this.touch()
  }

  private moveMove(g: MoveGesture, s: Vec2, p: Vec2, e: PointerIn): void {
    if (!g.active) {
      if (dist(s, g.startScreen) < CLICK_PX) return
      g.active = true
      this.lastClick = null
      if (g.ids.length > 0 && g.ids.every((id) => this.itemById(id)?.locked)) this.toastLocked()
    }
    let dx = p.x - g.start.x
    let dy = p.y - g.start.y
    // Shift holds the drag to the axis it mostly follows.
    const lockX = e.shift && Math.abs(dx) < Math.abs(dy)
    const lockY = e.shift && !lockX
    if (lockX) dx = 0
    if (lockY) dy = 0
    const snap = snapMove(g.base, g.ids, { x: dx, y: dy }, {
      threshold: SNAP_PX,
      zoom: this.zoom,
      grid: e.alt ? 0 : g.base.grid,
      metrics: this.metrics,
      edges: !e.alt,
    })
    const mx = lockX ? 0 : snap.delta.x
    const my = lockY ? 0 : snap.delta.y
    this.guides = { v: lockX ? [] : snap.guides.v, h: lockY ? [] : snap.guides.h }
    this.live(moveItems(g.base, g.ids, mx, my), 'move')
  }

  /** The board with the selection scaled the way the pointer at `p` asks for. */
  private scaleTo(g: ScaleGesture, p: Vec2, alt: boolean): BoardDoc {
    const { corners, rotation } = g.box
    const centre = mid(corners[0], corners[2])
    const w = dist(corners[0], corners[1])
    const h = dist(corners[0], corners[3])
    const [hx, hy] = handleDirection(g.handle)
    const turned = rotatePoint(p, centre, -rotation)
    const lx = turned.x - centre.x - g.grab.x
    const ly = turned.y - centre.y - g.grab.y
    if (g.note !== null && hy === 0) {
      // A note's side handles change its width and let the text reflow.
      const wanted = alt ? 2 * Math.abs(lx) : hx > 0 ? lx + w / 2 : w / 2 - lx
      return resizeNote(g.base, g.note, Math.max(wanted, 1e-6), alt ? 0 : hx > 0 ? -0.5 : 0.5, this.metrics)
    }
    // The factor is how far the pointer has gone along the line from the anchor to the handle, so the shape never changes.
    const handleAt = { x: (hx * w) / 2, y: (hy * h) / 2 }
    const anchor = alt ? { x: 0, y: 0 } : { x: -handleAt.x, y: -handleAt.y }
    const ax = handleAt.x - anchor.x
    const ay = handleAt.y - anchor.y
    const denom = ax * ax + ay * ay
    if (!(denom > 1e-12)) return g.base
    const factor = clampTo(((lx - anchor.x) * ax + (ly - anchor.y) * ay) / denom, 0.001, 1000)
    if (!Number.isFinite(factor)) return g.base
    const about = rotatePoint({ x: centre.x + anchor.x, y: centre.y + anchor.y }, centre, rotation)
    return scaleItems(g.base, g.ids, factor, about)
  }

  private rotateMove(g: RotateGesture, p: Vec2, snap: boolean): void {
    const angle = (Math.atan2(p.y - g.pivot.y, p.x - g.pivot.x) * 180) / Math.PI
    g.total += normalizeAngle(angle - g.lastAngle)
    g.lastAngle = angle
    let turn = g.total
    if (snap) {
      // A lone picture or note lands on a multiple of 15 degrees itself; a crowd turns by one.
      turn = g.r0 !== null ? Math.round((g.r0 + turn) / SNAP_ANGLE) * SNAP_ANGLE - g.r0 : Math.round(turn / SNAP_ANGLE) * SNAP_ANGLE
    }
    this.live(rotateItems(g.base, g.ids, turn, g.pivot), 'rotate')
  }

  /** The board with the picture cropped to where the pointer has dragged the frame's edge; what stays visible does not move. */
  private cropTo(g: CropGesture, p: Vec2): BoardDoc {
    const it = g.pic
    const c = it.crop
    const local = rotatePoint(p, { x: it.x, y: it.y }, -it.rotation)
    const lx = local.x - it.x - g.grab.x
    const ly = local.y - it.y - g.grab.y
    // Local x and y are in the shown frame; a flip reads the picture backwards, so the visible right edge is the picture's left.
    const sx = it.flipH ? -1 : 1
    const sy = it.flipV ? -1 : 1
    const u = (c.l + c.r) / 2 + (sx * lx) / it.w
    const v = (c.t + c.b) / 2 + (sy * ly) / it.h
    const min = BOARD_ITEM_LIMITS.cropMin
    const [hx, hy] = handleDirection(g.handle)
    let { l, t, r, b } = c
    if (hx > 0) {
      if (sx > 0) r = clampTo(u, l + min, 1)
      else l = clampTo(u, 0, r - min)
    } else if (hx < 0) {
      if (sx > 0) l = clampTo(u, 0, r - min)
      else r = clampTo(u, l + min, 1)
    }
    if (hy > 0) {
      if (sy > 0) b = clampTo(v, t + min, 1)
      else t = clampTo(v, 0, b - min)
    } else if (hy < 0) {
      if (sy > 0) t = clampTo(v, 0, b - min)
      else b = clampTo(v, t + min, 1)
    }
    return setCrop(g.base, it.id, { l, t, r, b })
  }

  private makeDraft(g: DrawGesture, p: Vec2, e: Pick<PointerIn, 'shift' | 'alt'>): BoardItem {
    const zoom = this.zoom
    const width = g.tool === 'pen' ? this.penWidth(g) : this.style.width / zoom
    const common = { id: 0, group: 0, locked: false, color: this.style.color, width }
    if (g.tool === 'pen') return { kind: 'stroke', ...common, points: g.pts.slice() }
    const { a, b } = this.shapeEnds(g, p, e)
    if (g.tool === 'line') return { kind: 'line', ...common, x1: a.x, y1: a.y, x2: b.x, y2: b.y, arrow: this.style.arrow }
    return { kind: g.tool, ...common, x1: a.x, y1: a.y, x2: b.x, y2: b.y, fill: this.style.fill }
  }

  /** A stroke's width: the style's, thickened by a pen's average pressure (half pressure, which a mouse reports, changes nothing). */
  private penWidth(g: DrawGesture): number {
    const base = this.style.width / this.zoom
    return g.pen ? base * (0.5 + g.pressureSum / Math.max(g.pressureN, 1)) : base
  }

  /** The two ends of a line or the two corners of a shape: Shift for 45 degree steps or equal sides, Alt for the press as the middle. */
  private shapeEnds(g: DrawGesture, p: Vec2, e: Pick<PointerIn, 'shift' | 'alt'>): { a: Vec2; b: Vec2 } {
    let b = p
    const dx = p.x - g.start.x
    const dy = p.y - g.start.y
    if (e.shift) {
      if (g.tool === 'line') {
        const len = Math.hypot(dx, dy)
        const step = Math.PI / 4
        const ang = Math.round(Math.atan2(dy, dx) / step) * step
        b = { x: g.start.x + len * Math.cos(ang), y: g.start.y + len * Math.sin(ang) }
      } else {
        const side = Math.max(Math.abs(dx), Math.abs(dy))
        b = { x: g.start.x + (dx < 0 ? -side : side), y: g.start.y + (dy < 0 ? -side : side) }
      }
    }
    const a = e.alt ? { x: 2 * g.start.x - b.x, y: 2 * g.start.y - b.y } : g.start
    return { a, b }
  }

  private drawMove(g: DrawGesture, s: Vec2, p: Vec2, e: PointerIn): void {
    g.mods = { shift: e.shift, alt: e.alt }
    if (g.tool !== 'pen') {
      this.draft = this.makeDraft(g, p, e)
      this.touch()
      return
    }
    if (g.pen) {
      g.pressureSum += this.pressureOf(e)
      g.pressureN++
    }
    if (dist(s, g.lastScreen) < POINT_SPACING_PX) return
    g.lastScreen = s
    g.pts.push(p.x, p.y)
    if (g.pts.length >> 1 > BOARD_LIMITS.strokePoints) {
      g.pts = capStroke(g.pts, BOARD_LIMITS.strokePoints, (STROKE_TOLERANCE_PX * 1.5) / this.zoom)
    }
    this.draft = g.pts.length >= 4 ? this.makeDraft(g, p, e) : null
    this.touch()
  }

  private finishDraw(g: DrawGesture, s: Vec2, p: Vec2): void {
    let mark: Parameters<typeof addMark>[1] | null = null
    if (g.tool === 'pen') {
      const pts = simplifyStroke(g.pts, STROKE_TOLERANCE_PX / this.zoom)
      const capped = capStroke(pts, BOARD_LIMITS.strokePoints, (STROKE_TOLERANCE_PX * 1.5) / this.zoom)
      if (capped.length >= 4) mark = { kind: 'stroke', points: capped, color: this.style.color, width: this.penWidth(g) }
    } else if (dist(s, g.startScreen) >= CLICK_PX) {
      // The mark the draft showed: the release gives the end point, the last move gave Shift and Alt (a key let go a moment before the button
      // is not a change of mind).
      const d = this.makeDraft(g, p, g.mods)
      const { id: _id, group: _group, locked: _locked, ...spec } = d
      mark = spec as Parameters<typeof addMark>[1]
    }
    this.draft = null
    if (!mark) return
    const res = addMark(this.doc, mark)
    if (res.id === null) {
      this.toastItemsFull()
      return
    }
    if (!this.fits(res.doc)) {
      this.refuseBudget()
      return
    }
    const label = g.tool === 'pen' ? 'Draw' : g.tool === 'line' ? (this.style.arrow ? 'Draw arrow' : 'Draw line') : `Draw ${g.tool === 'rect' ? 'rectangle' : 'ellipse'}`
    this.commit(res.doc, label, { reason: 'draw' })
  }

  private finishNote(g: NoteGesture, p: Vec2): void {
    this.draft = null
    this.gesture = null
    if (g.active) {
      const r = rectFrom(g.start, p)
      this.makeNote(r.x, r.y, Math.max(r.w, NOTE_MIN_WIDTH_PX / this.zoom))
    } else {
      this.makeNote(g.start.x, g.start.y, NOTE_WIDTH_PX / this.zoom)
    }
  }

  /** Removes the unlocked marks along the pointer's path from `from` to `to`; the removal is one history step when the pointer lifts. */
  private eraseTo(from: Vec2, to: Vec2): void {
    const g = this.gesture
    if (g?.kind !== 'erase') return
    const tol = ERASER_PX / this.zoom
    const len = dist(from, to)
    const hit = new Set<number>()
    for (const it of this.doc.items) {
      if (!isMark(it) || it.locked) continue
      let box = g.bounds.get(it.id)
      if (!box) {
        box = itemBounds(it, this.metrics)
        g.bounds.set(it.id, box)
      }
      if (!Number.isFinite(box.x + box.y + box.w + box.h)) continue
      // Only the part of the pointer's path that passes the mark's box is looked at, at points a radius apart: a mark crossing the path
      // is never stepped over, however fast the pointer went, and a mark far from the path costs nothing.
      const span = clipSegment(from, to, { x: box.x - tol, y: box.y - tol, w: box.w + 2 * tol, h: box.h + 2 * tol })
      if (!span) continue
      const steps = clampTo(Math.ceil(((span.t1 - span.t0) * len) / tol), 1, MAX_ERASE_STEPS)
      for (let i = 0; i <= steps; i++) {
        const t = span.t0 + ((span.t1 - span.t0) * i) / steps
        if (pointInItem(it, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, tol, this.metrics)) {
          hit.add(it.id)
          break
        }
      }
    }
    if (hit.size === 0) return
    this.setLive(removeItems(this.doc, [...hit]))
    this.reconcile()
    this.changed('erase', false)
  }

  /* --------------------------------------------------------- pan and zoom --- */

  private startPinch(first: number, e: PointerIn): void {
    this.cancelGesture()
    this.ignored.delete(first)
    const a = this.pointers.get(first)
    if (!a) return
    const b = { x: e.x, y: e.y }
    this.pinch = { a: first, b: e.id, mid: mid(a, b), dist: dist(a, b) }
    this.touch()
  }

  private pinchMove(): void {
    const pinch = this.pinch
    if (!pinch) return
    const a = this.pointers.get(pinch.a)
    const b = this.pointers.get(pinch.b)
    if (!a || !b) return
    const now = mid(a, b)
    const d = dist(a, b)
    let view = this.doc.view
    if (pinch.dist > 0 && d > 0) view = zoomAt(view, d / pinch.dist, pinch.mid, this.viewport)
    view = panView(view, now.x - pinch.mid.x, now.y - pinch.mid.y)
    pinch.mid = now
    if (d > 0) pinch.dist = d
    if (this.setViewDoc(view)) this.changed('pinch', false, true)
  }

  /**
   * The wheel zooms about the pointer (ctrl + wheel, which is how a trackpad pinch arrives, three times as fast); with Shift it pans
   * sideways and with Alt up and down. A trackpad's two-axis scrolling is not a pan: the wheel always zooms.
   */
  wheel(e: WheelIn): void {
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? this.viewport.h : 1
    const dx = fin(e.deltaX) * unit
    const dy = fin(e.deltaY) * unit
    let view = this.doc.view
    let reason = 'zoom'
    if (e.ctrl || !(e.shift || e.alt)) {
      const exponent = -dy * (e.ctrl ? WHEEL_PINCH_BOOST : 1)
      const factor = clampTo(Math.pow(WHEEL_BASE, exponent), 1 / WHEEL_MAX_FACTOR, WHEEL_MAX_FACTOR)
      view = zoomAt(view, factor, { x: fin(e.x), y: fin(e.y) }, this.viewport)
    } else if (e.shift) {
      reason = 'pan'
      view = panView(view, -(dx !== 0 ? dx : dy), 0)
    } else {
      reason = 'pan'
      view = panView(view, 0, -dy)
    }
    if (this.setViewDoc(view)) {
      this.wheelMoving = true
      if (this.wheelTimer !== null) clearTimeout(this.wheelTimer)
      this.wheelTimer = setTimeout(() => {
        this.wheelTimer = null
        this.wheelMoving = false
        this.touch()
        this.flush()
      }, WHEEL_SETTLE_MS)
      this.changed(reason, true, true)
    }
    this.flush()
  }

  private fitTo(bounds: Rect | null): void {
    if (this.setViewDoc(fitView(bounds, this.viewport, FIT_MARGIN_PX))) this.changed('fit', true, true)
  }

  /* ------------------------------------------------------------------ keys --- */

  /** A key press or release (never while a note's text box has focus). True when the board used the key. */
  key(e: KeyIn): boolean {
    const used = this.handleKey(e)
    this.flush()
    return used
  }

  private handleKey(e: KeyIn): boolean {
    if (e.code === 'Space' || e.key === ' ') {
      if (this.editingNote !== null) return false
      const down = e.down
      if (down !== this.space) {
        this.space = down
        this.touch()
      }
      return true
    }
    if (!e.down) return false
    if (this.editingNote !== null) {
      if (e.key !== 'Escape') return false
      this.cancelEditing()
      this.touch()
      return true
    }
    if (e.key === 'Escape') return this.escape()
    const arrow = nudgeOf(e)
    if (arrow) {
      if (this.selection.length === 0) return false
      // A drag in progress ends first (as for a command): the nudge is one step on the board as it was, not on a half-made drag.
      this.settleGesture()
      const step = e.shift ? NUDGE_BIG : NUDGE
      if (this.allSelectionLocked()) {
        if (!e.repeat) this.toastLocked()
        return true
      }
      this.edit('Nudge', (d) => moveItems(d, this.selection, arrow.x * step, arrow.y * step), { key: this.runKey(NUDGE_KEY), reason: 'nudge' })
      return true
    }
    let id = keyToCommand(e, { tool: this.tool, editing: this.editingNote !== null, cropping: this.cropping !== null })
    if (id === null) return false
    if (e.repeat && !isRepeatable(id)) return true
    if (id === 'picture.open' && e.key === 'Enter') {
      // Enter is "open" for a picture and "edit" for a lone note, and nothing at all (no complaint) when there is neither.
      const items = this.selectedItems()
      if (items.length === 1 && items[0]!.kind === 'note') id = 'note.edit'
      else if (!items.some((it) => it.kind === 'picture')) return false
    }
    this.run(id, undefined)
    return true
  }

  /** The Esc ladder: cancel what is under way, else leave cropping, else clear the selection, else go back to the select tool. */
  private escape(): boolean {
    if (this.gesture) {
      this.cancelGesture()
      return true
    }
    if (this.cropping !== null) {
      this.leaveCrop()
      return true
    }
    if (this.selection.length > 0) {
      this.setSelection([])
      return true
    }
    if (this.tool !== 'select') {
      this.setTool('select')
      return true
    }
    return false
  }

  /* -------------------------------------------------------------- commands --- */

  /** Runs a command (a key, a palette entry or a toolbar button). `arg` is only read by a few: see `run`. */
  exec(id: BoardCommandId, arg?: unknown): void {
    this.run(id, arg)
    this.flush()
  }

  private run(id: BoardCommandId, arg: unknown): void {
    // A command that only moves the camera leaves a note being typed alone; any other drops it (the shell commits it first).
    if (!(id.startsWith('view.zoom') || id.startsWith('view.fit') || id === 'view.hideUi' || id === 'arrange.menu')) this.cancelEditing()
    this.settleGesture()
    const [group_, name] = id.split('.') as [string, string]
    switch (group_) {
      case 'tool':
        this.setTool(name as BoardTool)
        return
      case 'edit':
        this.runEdit(id)
        return
      case 'note': {
        const items = this.selectedItems()
        if (items.length === 1 && items[0]!.kind === 'note') this.beginEdit(items[0]!.id)
        else this.toast('Select one note first.', 'info', 'select')
        return
      }
      case 'order':
        this.edit(`Move ${name}`, (d) => reorder(d, this.selection, name as 'front' | 'forward' | 'backward' | 'back', this.metrics), { reason: id })
        return
      case 'transform':
        this.runTransform(id)
        return
      case 'arrange':
      case 'sort':
      case 'align':
      case 'distribute':
      case 'normalize':
        this.runArrange(id, arg)
        return
      case 'view':
      case 'item':
        this.runView(id, arg)
        return
      case 'picture':
      case 'export':
      case 'window':
        this.runShell(id)
        return
    }
  }

  private runEdit(id: BoardCommandId): void {
    const sel = this.selection
    switch (id) {
      case 'edit.undo':
        this.stepHistory(this.hist.undo(), 'undo')
        return
      case 'edit.redo':
        this.stepHistory(this.hist.redo(), 'redo')
        return
      case 'edit.selectAll':
        this.setSelection(this.doc.items.map((it) => it.id))
        return
      case 'edit.selectNone':
        this.setSelection([])
        return
      case 'edit.invertSelection': {
        const chosen = new Set(sel)
        this.setSelection(this.doc.items.filter((it) => !chosen.has(it.id)).map((it) => it.id))
        return
      }
      case 'edit.duplicate': {
        const off = DUPLICATE_OFFSET_PX / this.zoom
        let made: number[] = []
        let tooBig = false
        const ok = this.edit('Duplicate', (d) => {
          const r = duplicateItems(d, sel, { x: off, y: off })
          if (r.ids.length > 0 && !this.fits(r.doc)) {
            tooBig = true
            return d
          }
          made = r.ids
          return r.doc
        })
        if (ok) this.setSelection(made)
        else if (tooBig) this.refuseBudget()
        else if (sel.length > 0 && !this.allSelectionLocked() && this.doc.items.length + sel.length > BOARD_LIMITS.items) this.toastItemsFull()
        return
      }
      case 'edit.delete':
        this.edit('Delete', (d) => removeItems(d, sel))
        return
      case 'edit.copy':
        this.copyStored = false
        this.copy(sel)
        return
      case 'edit.cut': {
        this.copyStored = false
        const free = this.selectedItems().filter((it) => !it.locked)
        if (free.length === 0) {
          if (sel.length > 0) this.toastLocked()
          return
        }
        this.copy(free.map((it) => it.id), true)
        this.edit('Cut', (d) => removeItems(d, sel))
        const kept = sel.length - free.length
        if (kept > 0) this.toast(`${kept} locked item${kept === 1 ? ' was' : 's were'} not cut.`, 'info')
        return
      }
      case 'edit.paste':
        this.paste()
        return
      case 'edit.group':
        this.edit('Group', (d) => group(d, sel), { select: sel })
        return
      case 'edit.ungroup':
        this.edit('Ungroup', (d) => ungroup(d, sel), { select: sel })
        return
      case 'edit.lock':
        // Everything is locked already: there is nothing to say (the "unlock them first" of a refused change would be wrong here).
        if (this.allSelectionLocked()) return
        this.edit('Lock', (d) => lockItems(d, sel, true), { select: sel })
        return
      case 'edit.unlock':
        this.edit('Unlock', (d) => lockItems(d, sel, false), { select: sel })
        return
    }
  }

  private stepHistory(snapshot: BoardDoc | null, reason: string): void {
    if (snapshot === null) return
    this.doc = this.fixAspects(withView(snapshot, this.doc.view))
    this.noteSilent()
    this.reconcile()
    this.changed(reason, true)
  }

  private copy(ids: readonly number[], quiet = false): void {
    const set = new Set(ids)
    // Copies of the items, unlocked: a pasted copy is a new item and nobody asked for it to be fixed.
    const items = this.doc.items
      .filter((it) => set.has(it.id))
      .map((it) => (it.kind === 'picture' ? { ...it, crop: { ...it.crop }, locked: false } : { ...it, locked: false }))
    if (items.length === 0) return
    this.clipboard = items
    this.copyStored = true
    this.pasteCount = 0
    this.touch()
    if (!quiet) this.toast(items.length === 1 ? 'Copied 1 item.' : `Copied ${items.length} items.`, 'info')
  }

  /**
   * The items the last copy or cut stored, as text for the SYSTEM clipboard: a first line the user can read ("Aether Brain board: 3
   * items copied"), then the items as a small board note (core `serializeBoard`), so that another board, another window or a later
   * session can paste them with `importCopy`. Null when the last copy or cut stored nothing (nothing selected, only locked items) or the
   * copy is too big to put there: the system clipboard is then left alone. Paste in the same session needs none of this: the items are
   * also kept in memory.
   */
  exportCopy(): { text: string; count: number } | null {
    if (!this.copyStored || this.clipboard.length === 0) return null
    const items = this.clipboard.map((it, i) => ({ ...it, id: i + 1 }))
    const board: BoardDoc = { ...emptyBoard('Copied items'), items, nextId: items.length + 1 }
    const text = `Aether Brain board: ${items.length} item${items.length === 1 ? '' : 's'} copied\n${serializeBoard(board)}`
    return text.length > MAX_COPY_CHARS ? null : { text, count: items.length }
  }

  /**
   * Paste what `exportCopy` made (read from the system clipboard) into this board with its middle at `at` (board units; the view's
   * middle when absent). The text is untrusted: it is read with the board reader (its limits apply: item count, points, characters),
   * only its items are taken, and they go in through the same door as a paste (new ids, the item cap, the character budget).
   * Returns how many items were pasted, 0 when nothing was (the board is full, the items cannot be read: the user is told), or null
   * when `text` is not a copy from a board at all. Never throws.
   */
  importCopy(text: string, at?: Vec2): number | null {
    let n = 0
    try {
      if (typeof text !== 'string') return null
      const head = COPY_HEAD.exec(text.length > 200 ? text.slice(0, 200) : text)
      if (!head) return null
      this.cancelGesture()
      this.cancelEditing()
      n = this.pasteForeign(text.slice(head[0].length), at)
    } catch {
      n = 0
    }
    this.flush()
    return n
  }

  private pasteForeign(body: string, at?: Vec2): number {
    if (body.length > MAX_COPY_CHARS) {
      this.toast('Those items are too big to paste.', 'error')
      return 0
    }
    const items = parseBoard(body).doc.items
    const bounds = itemsBounds(items, this.metrics)
    if (items.length === 0 || !bounds) {
      this.toast('Those items could not be read. Copy them again.', 'error')
      return 0
    }
    const view = this.doc.view
    const goal = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : { x: view.x, y: view.y }
    // Pasted again on the same spot, the copies fan out like a paste of the board's own items does.
    const again = this.lastImport && Math.abs(this.lastImport.x - goal.x) < 1e-6 && Math.abs(this.lastImport.y - goal.y) < 1e-6
    const n = again ? this.lastImport!.n + 1 : 0
    this.lastImport = { x: goal.x, y: goal.y, n }
    const step = (DUPLICATE_OFFSET_PX * n) / view.zoom
    const offset = { x: goal.x - (bounds.x + bounds.w / 2) + step, y: goal.y - (bounds.y + bounds.h / 2) + step }
    const res = insertItems(this.doc, items, offset)
    if (res.ids.length === 0) {
      this.toastItemsFull()
      return 0
    }
    if (!this.fits(res.doc)) {
      this.refuseBudget()
      return 0
    }
    this.commit(res.doc, 'Paste', { select: res.ids })
    return res.ids.length
  }

  private paste(): void {
    if (this.clipboard.length === 0) return
    const bounds = itemsBounds(this.clipboard, this.metrics)
    const view = this.doc.view
    const halfW = this.viewport.w / 2 / view.zoom
    const halfH = this.viewport.h / 2 / view.zoom
    const visible =
      bounds !== null &&
      bounds.x < view.x + halfW &&
      bounds.x + bounds.w > view.x - halfW &&
      bounds.y < view.y + halfH &&
      bounds.y + bounds.h > view.y - halfH
    let offset: Vec2
    if (bounds && visible) {
      this.pasteCount++
      const step = (DUPLICATE_OFFSET_PX * this.pasteCount) / view.zoom
      offset = { x: step, y: step }
    } else {
      // The originals are out of sight: the copies land where the user is looking.
      this.pasteCount = 0
      offset = bounds ? { x: view.x - (bounds.x + bounds.w / 2), y: view.y - (bounds.y + bounds.h / 2) } : { x: 0, y: 0 }
    }
    const res = insertItems(this.doc, this.clipboard, offset)
    if (res.ids.length === 0) {
      this.toastItemsFull()
      return
    }
    if (!this.fits(res.doc)) {
      this.refuseBudget()
      return
    }
    this.commit(res.doc, 'Paste', { select: res.ids })
  }

  private runTransform(id: BoardCommandId): void {
    const sel = this.selection
    const free = this.selectedItems().filter((it) => !it.locked)
    switch (id) {
      case 'transform.flipH':
        this.edit('Flip horizontally', (d) => flipItems(d, sel, 'h', undefined, this.metrics))
        return
      case 'transform.flipV':
        this.edit('Flip vertically', (d) => flipItems(d, sel, 'v', undefined, this.metrics))
        return
      case 'transform.rotateCw':
      case 'transform.rotateCcw': {
        const b = itemsBounds(free, this.metrics)
        const pivot = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: 0, y: 0 }
        // A quarter turn is exact: a frame round a picture turns with it (a free turn by dragging leaves shapes upright).
        this.edit('Rotate', (d) => rotateItems(d, sel, id === 'transform.rotateCw' ? 90 : -90, pivot, { exactQuarter: true }))
        return
      }
      case 'transform.resetRotation':
        this.edit('Reset rotation', (d) => setProps(d, sel, { rotation: 0 }, this.metrics))
        return
      case 'transform.resetScale':
        this.edit('Reset size', (d) => normalize(d, sel, 'scale', { target: 1, natural: (p) => this.exactNaturalSize(p), metrics: this.metrics }))
        this.toastSkippedSizes()
        return
      case 'transform.resetCrop':
        this.edit('Reset crop', (d) => resetCrop(d, sel))
        return
      case 'transform.resetAll':
        this.edit('Reset', (d) => {
          let doc = resetCrop(d, sel)
          doc = setProps(doc, sel, { rotation: 0, flipH: false, flipV: false, opacity: 1 }, this.metrics)
          return normalize(doc, sel, 'scale', { target: 1, natural: (p) => this.exactNaturalSize(p), metrics: this.metrics })
        })
        this.toastSkippedSizes()
        return
    }
  }

  /** Pictures of the selection whose own size is not known for sure yet: Reset size, Show at own size and 100% left them as they were. */
  private toastSkippedSizes(): void {
    const skipped = this.selectedItems().filter((it) => it.kind === 'picture' && !it.locked && !this.exactNaturalSize(it.path)).length
    if (skipped === 0) return
    this.toast(
      `${skipped} picture${skipped === 1 ? ' was' : 's were'} left as ${skipped === 1 ? 'it was' : 'they were'}: ${skipped === 1 ? 'its' : 'their'} own size is not known yet. Try again in a moment.`,
      'info',
      'select',
    )
  }

  private runArrange(id: BoardCommandId, arg: unknown): void {
    if (id === 'arrange.menu') {
      this.emit({ type: 'command', id, ids: this.selection, paths: [] })
      return
    }
    const [family, name] = id.split('.') as [string, string]
    const sel = this.selection
    if (family === 'align' || family === 'distribute' || family === 'normalize') {
      const need = family === 'distribute' ? 3 : name === 'scale' ? 1 : 2
      if (sel.length < need) {
        this.toast(need === 1 ? 'Select a picture first.' : `Select at least ${need} items first.`, 'info', 'select')
        return
      }
    }
    if (family === 'align') {
      const done = this.edit('Align', (d) => align(d, sel, name as AlignEdge, this.metrics))
      if (done) this.toast(`Aligned ${sel.length} items (${name}).`, 'success')
      return
    }
    if (family === 'distribute') {
      const done = this.edit('Distribute', (d) => distribute(d, sel, name as 'h' | 'v', this.metrics))
      if (done) this.toast(`Spread ${sel.length} items evenly ${name === 'h' ? 'across' : 'down'}.`, 'success')
      return
    }
    if (family === 'normalize') {
      const natural = (p: string): { w: number; h: number } | null => this.exactNaturalSize(p)
      const done = this.edit('Normalize', (d) => normalize(d, sel, name as NormalizeMode, { natural, metrics: this.metrics }))
      if (done) this.toast(name === 'scale' ? 'Showing the pictures at their own size.' : `Made the pictures the same ${name}.`, 'success')
      if (name === 'scale') this.toastSkippedSizes()
      return
    }
    // Arrange and sort: the selection when it holds two or more items, the whole board when nothing is selected. One item selected is
    // neither: it would rearrange everything the user did not point at.
    if (sel.length === 1) {
      this.toast('Select two or more items (or none, for the whole board).', 'info', 'select')
      return
    }
    const ids = sel.length >= 2 ? sel : this.doc.items.filter(isLaidOut).map((it) => it.id)
    if (ids.length === 0) return
    const o: ArrangeOptions = { metrics: this.metrics, aspect: clampTo(this.viewport.w / this.viewport.h, 0.5, 3) }
    if (arg && typeof arg === 'object') {
      const a = arg as Partial<ArrangeOptions>
      if (typeof a.gap === 'number' && Number.isFinite(a.gap)) o.gap = a.gap
      if (typeof a.aspect === 'number' && a.aspect > 0 && Number.isFinite(a.aspect)) o.aspect = a.aspect
      if (typeof a.columns === 'number' && Number.isFinite(a.columns)) o.columns = a.columns
    }
    let mode: ArrangeMode = 'optimal'
    let label = 'Arrange'
    let said = ''
    if (family === 'arrange') {
      mode = name as ArrangeMode
      said = mode === 'optimal' ? 'in an optimal layout' : mode === 'stack' ? 'in a pile' : `in a ${mode}`
    } else {
      const order = name as ArrangeOrder
      o.order = order
      if (order === 'shuffle') o.seed = Math.floor(this.clock()) + this.shuffles++
      label = 'Sort'
      said = order === 'shuffle' ? 'in a shuffled order' : order === 'added' ? 'in the order they were added' : `by ${order}`
    }
    const count = ids.filter((i) => isLaidOut(this.itemById(i)!)).length
    const next = arrange(this.doc, ids, mode, o)
    if (next === this.doc) {
      this.refuseLockedIn(ids)
      return
    }
    this.commit(next, label, { reason: id })
    this.toast(`${label === 'Sort' ? 'Sorted' : 'Arranged'} ${count} item${count === 1 ? '' : 's'} ${said}.`, 'success')
  }

  private refuseLockedIn(ids: readonly number[]): void {
    const set = new Set(ids)
    const items = this.doc.items.filter((it) => set.has(it.id) && isLaidOut(it))
    if (items.length > 0 && items.every((it) => it.locked)) this.toastLocked()
  }

  private runView(id: BoardCommandId, arg: unknown): void {
    const doc = this.doc
    switch (id) {
      case 'view.gray':
        this.commit({ ...doc, gray: !doc.gray }, doc.gray ? 'Colour' : 'Grey', { reason: id })
        return
      case 'view.grayItem': {
        const pics = this.selectedItems().filter((it): it is PictureItem => it.kind === 'picture' && !it.locked)
        if (pics.length === 0) {
          if (this.allSelectionLocked()) this.toastLocked()
          return
        }
        const gray = !pics.every((p) => p.gray)
        this.commit(setProps(doc, pics.map((p) => p.id), { gray }, this.metrics), gray ? 'Grey pictures' : 'Colour pictures', { reason: id })
        return
      }
      case 'view.smooth':
        this.commit({ ...doc, smooth: !doc.smooth }, 'Smoothing', { reason: id })
        this.toast(this.doc.smooth ? 'Pictures are smoothed.' : 'Pictures show crisp pixels.', 'info')
        return
      case 'view.captions':
        this.commit({ ...doc, captions: !doc.captions }, 'Captions', { reason: id })
        return
      case 'view.background': {
        const given = hex6(arg)
        let next: { name: string; hex: string }
        if (given) next = { name: given, hex: given }
        else {
          const at = BOARD_BACKGROUNDS.findIndex((b) => b.hex === doc.bg)
          next = BOARD_BACKGROUNDS[(at + 1) % BOARD_BACKGROUNDS.length]!
        }
        this.commit({ ...doc, bg: next.hex }, 'Background', { reason: id })
        return
      }
      case 'view.gridSnap':
        // Switching snapping off keeps the size the grid had, so that switching it on again brings that size back.
        if (doc.grid > 0) this.lastGrid = doc.grid
        this.commit({ ...doc, grid: doc.grid > 0 ? 0 : this.lastGrid }, 'Snap to grid', { reason: id })
        this.toast(this.doc.grid > 0 ? 'Snapping to a grid.' : 'Grid snapping off.', 'info')
        return
      case 'item.opacityUp':
      case 'item.opacityDown': {
        const sign = id === 'item.opacityUp' ? 1 : -1
        this.edit('Opacity', (d) => {
          let next = d
          for (const it of this.selectedItems()) {
            if (it.kind !== 'picture' || it.locked) continue
            const o = Math.round((it.opacity + sign * OPACITY_STEP) * 100) / 100
            next = setProps(next, [it.id], { opacity: o }, this.metrics)
          }
          return next
        }, { key: this.runKey(OPACITY_KEY), reason: id })
        return
      }
      case 'view.fitAll':
        this.fitTo(itemsBounds(doc.items, this.metrics))
        return
      case 'view.fitSelection':
        this.fitTo(itemsBounds(this.selection.length > 0 ? this.selectedItems() : doc.items, this.metrics))
        return
      case 'view.zoom100': {
        const pics = this.selectedItems().filter((it): it is PictureItem => it.kind === 'picture')
        const pic = pics.find((it) => this.exactNaturalSize(it.path))
        if (pic) {
          const nat = this.exactNaturalSize(pic.path)!
          // One picture pixel per screen pixel: the screen shows `nat.w` pixels across the `w` board units of the whole picture.
          const want = nat.w / pic.w
          const view = { x: pic.x, y: pic.y, zoom: want }
          if (this.setViewDoc(view)) this.changed('zoom', true, true)
          // A picture shown very small (or very large) is out of the camera's reach: say so instead of stopping short without a word.
          if (Math.abs(this.doc.view.zoom / want - 1) > 0.01) {
            this.toast(
              `100% is out of reach for this picture: it would need ${Number(want.toPrecision(3))}× and the board zooms between ${BOARD_LIMITS.zoomMin}× and ${BOARD_LIMITS.zoomMax}×. Reset its size first.`,
              'info',
              'select',
            )
          }
        } else {
          if (this.setViewDoc({ ...doc.view, zoom: 1 })) this.changed('zoom', true, true)
          if (pics.length > 0) this.toast('That picture’s own size is not known yet, so this is 100% of the board. Try again in a moment.', 'info', 'select')
        }
        return
      }
      case 'view.zoomIn':
      case 'view.zoomOut': {
        const factor = id === 'view.zoomIn' ? ZOOM_STEP : 1 / ZOOM_STEP
        const middle = { x: this.viewport.w / 2, y: this.viewport.h / 2 }
        if (this.setViewDoc(zoomAt(doc.view, factor, middle, this.viewport))) this.changed('zoom', true, true)
        return
      }
      case 'view.hideUi':
        this.emit({ type: 'command', id, ids: [], paths: [] })
        return
    }
  }

  /** Commands only the shell can do (it has the host): the controller says which, and on what. */
  private runShell(id: BoardCommandId): void {
    const pictures = this.selectedItems().filter((it): it is PictureItem => it.kind === 'picture')
    const paths = [...new Set(pictures.map((p) => p.path))]
    switch (id) {
      case 'picture.add':
      case 'window.popOut':
      case 'window.dock':
      case 'window.onTop':
        this.emit({ type: 'command', id, ids: [], paths: [] })
        return
      case 'export.board':
        this.emit({ type: 'command', id, ids: this.doc.items.map((it) => it.id), paths: [] })
        return
      case 'export.selection':
        if (this.selection.length === 0) this.toast('Select something to export first.', 'info', 'select')
        else this.emit({ type: 'command', id, ids: this.selection, paths })
        return
      case 'picture.palette': {
        if (pictures.length === 0) {
          this.toast('Select a picture first.', 'info', 'select')
          return
        }
        const b = itemsBounds(pictures, this.metrics)
        const near = b ? { x: b.x + b.w / 2, y: b.y + b.h + 16 / this.zoom } : { x: this.doc.view.x, y: this.doc.view.y }
        this.emit({ type: 'palette-request', ids: pictures.map((p) => p.id), near })
        return
      }
      default:
        if (pictures.length === 0) this.toast('Select a picture first.', 'info', 'select')
        else this.emit({ type: 'command', id, ids: pictures.map((p) => p.id), paths })
    }
  }
}

/** The direction of an arrow key (without the modifiers that mean something else), or null. */
function nudgeOf(e: KeyIn): Vec2 | null {
  if (e.ctrl || e.meta || e.alt) return null
  switch (e.key) {
    case 'ArrowLeft':
      return { x: -1, y: 0 }
    case 'ArrowRight':
      return { x: 1, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -1 }
    case 'ArrowDown':
      return { x: 0, y: 1 }
    default:
      return null
  }
}
