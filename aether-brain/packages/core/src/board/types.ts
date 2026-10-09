/**
 * The reference board: a PureRef-style canvas of pictures, text notes and drawn marks. This file is the data model, shared by the
 * markdown format (format.ts), the pure operations (ops.ts, arrange.ts, geometry.ts, history.ts) and the board view in
 * packages/ui. Everything here is plain data: no DOM, no Electron. Design: docs/design/reference-board.md.
 *
 * Units. The board is an unbounded plane of "board units". x grows to the right, y grows DOWN (like the screen). Angles are
 * degrees, clockwise on screen. A picture's `w` / `h` are its size in board units at zoom 1.
 */

export const BOARD_VERSION = 1

/** Hard limits: a board that passes them is cut on load (with a warning) and refuses more. Nothing a view draws is unbounded. */
export const BOARD_LIMITS = {
  /** Items on one board (pictures, notes and marks together). */
  items: 1500,
  /** Characters in one text note. */
  noteChars: 4000,
  /** Points in one pen stroke (a longer stroke is simplified while it is drawn). */
  strokePoints: 3000,
  /** Zoom range: screen pixels per board unit. */
  zoomMin: 0.005,
  zoomMax: 64,
  /** Smallest and largest edge of a picture, in board units. */
  pictureMin: 8,
  pictureMax: 40000,
  /** Largest coordinate magnitude; items are kept inside so floating-point stays exact enough. */
  coordinate: 1_000_000,
  /** Characters in the whole board note (the editor goes read-only at 400,000; a board stays far under it). */
  noteTotal: 300_000,
} as const

/** The board point at the centre of the viewport, and the zoom (screen pixels per board unit). */
export interface BoardView {
  x: number
  y: number
  zoom: number
}

/** The part of a picture that is shown, as fractions of the whole picture: 0 <= l < r <= 1 and 0 <= t < b <= 1. */
export interface Crop {
  l: number
  t: number
  r: number
  b: number
}

/** A note's inner margin and its line height, as multiples of its font size (shared by the estimate, the renderer and hit testing). */
export const NOTE_PADDING_EM = 0.5
export const NOTE_LINE_HEIGHT_EM = 1.25

export const FULL_CROP: Readonly<Crop> = Object.freeze({ l: 0, t: 0, r: 1, b: 1 })

export interface ItemCommon {
  /** Unique on its board while it is open (assigned when the board is read, counted up by `nextId`). Not stored in the file. */
  id: number
  /** 0: in no group. Items with the same non-zero group are selected and moved together. Stored as `g=` (renumbered from 1). */
  group: number
  /** A locked item cannot be moved, scaled, rotated, cropped or deleted until it is unlocked (it can still be selected). */
  locked: boolean
}

/**
 * A picture of the vault. `x`, `y` are the centre of the SHOWN part (the crop rectangle) in board space; `w`, `h` are the size of the
 * WHOLE picture in board units (so the shown part is (r-l)*w by (b-t)*h). Cropping changes `crop` and moves `x`, `y` so the picture
 * content does not move on screen (ops.setCrop). Rotation is about the centre of the shown part. Flips mirror the picture's own pixels
 * (inside the shown part), they do not move the item.
 */
export interface PictureItem extends ItemCommon {
  kind: 'picture'
  /** Vault path of the picture (as `VaultAsset.path`: the mount segment first in a multi-root vault). */
  path: string
  x: number
  y: number
  w: number
  h: number
  /** Degrees clockwise, in (-180, 180]. */
  rotation: number
  crop: Crop
  flipH: boolean
  flipV: boolean
  /** Shown in grey (this picture only; the board's `gray` greys everything). */
  gray: boolean
  /** 0.05 to 1. */
  opacity: number
  /** A name shown under the picture when captions are on; may be empty. Plain text. */
  caption: string
}

/** A text note. `x`, `y` is its centre, `w` the width the text wraps to; its height follows the text (TextMetrics). */
export interface NoteItem extends ItemCommon {
  kind: 'note'
  /** Plain text, may hold line breaks; at most BOARD_LIMITS.noteChars. */
  text: string
  x: number
  y: number
  w: number
  /** Font size in board units. */
  size: number
  rotation: number
  /** Text colour, 6 hex digits without the #. */
  color: string
  /** Background colour, 6 hex digits without the #, or '' for none. */
  fill: string
}

/** A free-hand pen stroke: absolute board points (x0, y0, x1, y1 ...) as drawn. */
export interface StrokeItem extends ItemCommon {
  kind: 'stroke'
  points: number[]
  color: string
  /** Line width in board units. */
  width: number
}

/** A straight line, optionally with an arrow head at (x2, y2). */
export interface LineItem extends ItemCommon {
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
  arrow: boolean
}

/** An axis-aligned rectangle through two opposite corners. */
export interface RectItem extends ItemCommon {
  kind: 'rect'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
  /** '' for an outline only. */
  fill: string
}

/** An axis-aligned ellipse inside the rectangle through two opposite corners. */
export interface EllipseItem extends ItemCommon {
  kind: 'ellipse'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
  fill: string
}

export type BoardItem = PictureItem | NoteItem | StrokeItem | LineItem | RectItem | EllipseItem
export type BoardItemKind = BoardItem['kind']

/** Items drawn by hand: they have no rotation of their own and are moved and scaled by rewriting their points. */
export type MarkItem = StrokeItem | LineItem | RectItem | EllipseItem

export interface BoardDoc {
  version: typeof BOARD_VERSION
  /** The board's title (the note's `title:`). */
  title: string
  view: BoardView
  /** Background colour of the canvas, 6 hex digits without the #. */
  bg: string
  /** Everything shown in grey. */
  gray: boolean
  /** Pictures are smoothed when scaled (false: crisp pixels). */
  smooth: boolean
  /** Names under pictures. */
  captions: boolean
  /** Snap-to-grid size in board units, 0 for none. */
  grid: number
  /** Back to front: the first item is drawn first (at the back). */
  items: BoardItem[]
  /** The next free item id. */
  nextId: number
  /**
   * Lines of the board section that this version of the app did not understand, kept as they were and written back at the end of the
   * section, so a board edited by hand or by a newer version loses nothing.
   */
  extra: string[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Vec2 {
  x: number
  y: number
}

/** A text layout: wrapped lines and the size they take. Supplied by the renderer (real font metrics) or estimated. */
export interface TextLayout {
  lines: string[]
  /** Width of the widest line. */
  width: number
  /** Height of all lines. */
  height: number
}

export interface TextMetrics {
  layout(text: string, size: number, maxWidth: number): TextLayout
}

/** The board a fresh note starts with. */
export function emptyBoard(title: string): BoardDoc {
  return {
    version: BOARD_VERSION,
    title,
    view: { x: 0, y: 0, zoom: 1 },
    bg: '14161d',
    gray: false,
    smooth: true,
    captions: false,
    grid: 0,
    items: [],
    nextId: 1,
    extra: [],
  }
}
