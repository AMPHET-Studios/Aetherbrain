/**
 * Shared scaffolding of the board controller tests: a board builder, a rig that drives a BoardController with scripted pointer, wheel
 * and key events (and records what it said), and a few checks on a board. Not a test file itself.
 *
 * The rig's canvas is 1000 by 800 CSS pixels and the view starts at board (0, 0) at zoom 1, so a board point (x, y) is the canvas
 * pixel (x + 500, y + 400): `at(x, y)` does that sum.
 */
import {
  BOARD_LIMITS,
  addMark,
  addNote,
  addPicture,
  emptyBoard,
  estimateTextMetrics,
  group,
  lockItems,
  type BoardDoc,
  type BoardItem,
  type NewMark,
  type NewNote,
  type NewPicture,
  type TextMetrics,
  type Vec2,
} from '@aether/core'
import { BoardController, type BoardChangeWhy, type BoardControllerOptions } from '../src/board/controller'
import type { BoardEvent, BoardUiState, KeyIn, PointerIn, WheelIn } from '../src/board/api'

export const VIEWPORT = { w: 1000, h: 800 }

/** The canvas pixel of a board point when the view is at (0, 0), zoom 1. */
export function at(x: number, y: number): Vec2 {
  return { x: x + VIEWPORT.w / 2, y: y + VIEWPORT.h / 2 }
}

/* -------------------------------------------------------------- the builder --- */

/** The id of each thing built, by the name it was given; a name that was not given throws (a typo in a test is not an undefined id). */
// `any` because noUncheckedIndexedAccess would make every `id.a` possibly undefined, and the proxy below makes sure it never is.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ids = Record<string, any>

export interface Built {
  doc: BoardDoc
  id: Ids
}

function strictIds(ids: Record<string, number>): Ids {
  return new Proxy(ids, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined
      const v = target[prop]
      if (v === undefined) throw new Error(`nothing was built under the name "${prop}"`)
      return v
    },
  })
}

class Builder {
  doc: BoardDoc
  readonly id: Record<string, number> = {}

  constructor(start: BoardDoc) {
    this.doc = start
  }

  private name(name: string, id: number | null): number {
    if (id === null) throw new Error(`could not add ${name}`)
    this.id[name] = id
    return id
  }

  pic(name: string, x: number, y: number, w: number, h: number, extra: Partial<NewPicture> = {}): this {
    const r = addPicture(this.doc, { path: `${name}.png`, x, y, w, h, ...extra })
    this.doc = r.doc
    this.name(name, r.id)
    return this
  }

  note(name: string, x: number, y: number, w: number, text = 'note', extra: NewNote = {}): this {
    const r = addNote(this.doc, { x, y, w, text, size: 20, ...extra })
    this.doc = r.doc
    this.name(name, r.id)
    return this
  }

  mark(name: string, mark: NewMark): this {
    const r = addMark(this.doc, mark)
    this.doc = r.doc
    this.name(name, r.id)
    return this
  }

  line(name: string, x1: number, y1: number, x2: number, y2: number, width = 4): this {
    return this.mark(name, { kind: 'line', x1, y1, x2, y2, color: 'ff0000', width, arrow: false })
  }

  rect(name: string, x1: number, y1: number, x2: number, y2: number, fill = '', width = 4): this {
    return this.mark(name, { kind: 'rect', x1, y1, x2, y2, color: 'ff0000', width, fill })
  }

  stroke(name: string, points: number[], width = 4): this {
    return this.mark(name, { kind: 'stroke', points, color: '00ff00', width })
  }

  /** Puts the named items in one group. */
  group(...names: string[]): this {
    this.doc = group(
      this.doc,
      names.map((n) => this.id[n]!),
    )
    return this
  }

  lock(...names: string[]): this {
    this.doc = lockItems(
      this.doc,
      names.map((n) => this.id[n]!),
      true,
    )
    return this
  }
}

export function build(fn: (b: Builder) => void, start: BoardDoc = emptyBoard('test')): Built {
  const b = new Builder(start)
  fn(b)
  return { doc: b.doc, id: strictIds(b.id) }
}

/** Two pictures and a note far apart, the board most gesture tests start from. */
export function threeThings(): Built {
  return build((b) =>
    b
      .pic('a', -300, -100, 200, 100)
      .pic('b', 100, -100, 200, 100)
      .note('n', 0, 250, 240, 'hello', {}),
  )
}

/* ---------------------------------------------------------------------- rig --- */

export interface Mods {
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
}

export interface PointerOpts extends Mods {
  id?: number
  button?: number
  pointerType?: PointerIn['pointerType']
  pressure?: number
  time?: number
}

export class Rig {
  readonly c: BoardController
  readonly events: BoardEvent[] = []
  readonly changes: { doc: BoardDoc; why: BoardChangeWhy }[] = []
  readonly states: BoardUiState[] = []
  /** Off for a test that makes tens of thousands of changes: each state holds a board. */
  keepStates = true
  /** The clock of pointer events (event.timeStamp) and, separately, the one history coalescing runs on. */
  t = 1000
  clock = 1_000_000
  private pressed = new Map<number, number>()

  constructor(doc: BoardDoc, opts: Partial<BoardControllerOptions> = {}) {
    this.c = new BoardController({ doc, viewport: VIEWPORT, now: () => this.clock, ...opts })
    this.c.onEvent((e) => this.events.push(e))
    this.c.onChange((d, why) => this.changes.push({ doc: d, why }))
    this.c.subscribe((s) => {
      if (this.keepStates) this.states.push(s)
    })
  }

  get s(): BoardUiState {
    return this.c.state
  }

  get doc(): BoardDoc {
    return this.c.state.doc
  }

  item<T extends BoardItem = BoardItem>(id: number): T {
    const it = this.doc.items.find((i) => i.id === id)
    if (!it) throw new Error(`no item ${id}`)
    return it as T
  }

  has(id: number): boolean {
    return this.doc.items.some((i) => i.id === id)
  }

  toasts(code?: string): BoardEvent[] {
    return this.events.filter((e) => e.type === 'toast' && (code === undefined || e.code === code))
  }

  eventsOf<K extends BoardEvent['type']>(type: K): Extract<BoardEvent, { type: K }>[] {
    return this.events.filter((e): e is Extract<BoardEvent, { type: K }> => e.type === type)
  }

  forget(): void {
    this.events.length = 0
    this.changes.length = 0
    this.states.length = 0
  }

  /* ------------------------------------------------------------ pointers --- */

  private pointer(x: number, y: number, o: PointerOpts, down: boolean, advance: number): PointerIn {
    this.t += advance
    const id = o.id ?? 1
    const button = o.button ?? 0
    return {
      id,
      x,
      y,
      button,
      buttons: down ? 1 << (button === 2 ? 1 : button === 1 ? 2 : 0) : 0,
      shift: o.shift ?? false,
      ctrl: o.ctrl ?? false,
      alt: o.alt ?? false,
      meta: o.meta ?? false,
      pointerType: o.pointerType ?? 'mouse',
      pressure: o.pressure ?? 0.5,
      time: o.time ?? this.t,
    }
  }

  down(p: Vec2, o: PointerOpts = {}): void {
    const e = this.pointer(p.x, p.y, o, true, 1000)
    this.pressed.set(e.id, e.button)
    this.c.pointerDown(e)
  }

  /** A move with the button held (the one that went down for this pointer). */
  move(p: Vec2, o: PointerOpts = {}): void {
    const id = o.id ?? 1
    const held = this.pressed.has(id)
    const e = this.pointer(p.x, p.y, { button: this.pressed.get(id) ?? 0, ...o }, held, 10)
    this.c.pointerMove(e)
  }

  /** A move with no button down. */
  hover(p: Vec2, o: PointerOpts = {}): void {
    this.c.pointerMove(this.pointer(p.x, p.y, o, false, 10))
  }

  up(p: Vec2, o: PointerOpts = {}): void {
    const id = o.id ?? 1
    const e = this.pointer(p.x, p.y, { button: this.pressed.get(id) ?? 0, ...o }, false, 10)
    this.pressed.delete(id)
    this.c.pointerUp(e)
  }

  cancel(p: Vec2, o: PointerOpts = {}): void {
    const id = o.id ?? 1
    const e = this.pointer(p.x, p.y, { button: this.pressed.get(id) ?? 0, ...o }, false, 10)
    this.pressed.delete(id)
    this.c.pointerCancel(e)
  }

  click(p: Vec2, o: PointerOpts = {}): void {
    this.down(p, o)
    this.up(p, o)
  }

  /** Two clicks 100 ms apart: a double click. */
  dblclick(p: Vec2, o: PointerOpts = {}): void {
    this.t += 5000
    const t0 = this.t
    this.down(p, { ...o, time: t0 })
    this.up(p, { ...o, time: t0 + 20 })
    this.down(p, { ...o, time: t0 + 120 })
    this.up(p, { ...o, time: t0 + 140 })
  }

  /** Press at `from`, move through `steps` points on the straight way to `to`, release at `to`. */
  drag(from: Vec2, to: Vec2, o: PointerOpts = {}, steps = 4): void {
    this.down(from, o)
    this.dragMoves(from, to, o, steps)
    this.up(to, o)
  }

  /** The moves of a drag, with the button still down at the end. */
  dragMoves(from: Vec2, to: Vec2, o: PointerOpts = {}, steps = 4): void {
    for (let i = 1; i <= steps; i++) {
      this.move({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, o)
    }
  }

  /* -------------------------------------------------------------- keys --- */

  /** A key press (and nothing else): `k` is what KeyboardEvent.key says; brackets get their code. */
  key(k: string, m: Mods & { repeat?: boolean; code?: string; down?: boolean } = {}): boolean {
    const letter = k.length === 1 && /[a-z]/i.test(k)
    const code =
      m.code ??
      (k === '[' ? 'BracketLeft' : k === ']' ? 'BracketRight' : k === ' ' ? 'Space' : letter ? `Key${k.toUpperCase()}` : k.length === 1 && /\d/.test(k) ? `Digit${k}` : k)
    const e: KeyIn = {
      key: letter && m.shift ? k.toUpperCase() : k,
      code,
      down: m.down ?? true,
      shift: m.shift ?? false,
      ctrl: m.ctrl ?? false,
      alt: m.alt ?? false,
      meta: m.meta ?? false,
      repeat: m.repeat ?? false,
    }
    return this.c.key(e)
  }

  release(k: string): boolean {
    return this.key(k, { down: false })
  }

  wheel(x: number, y: number, deltaY: number, o: Mods & { deltaX?: number; deltaMode?: number } = {}): void {
    const e: WheelIn = {
      x,
      y,
      deltaX: o.deltaX ?? 0,
      deltaY,
      deltaMode: o.deltaMode ?? 0,
      ctrl: o.ctrl ?? false,
      shift: o.shift ?? false,
      alt: o.alt ?? false,
    }
    this.c.wheel(e)
  }
}

/* ------------------------------------------------------------------ checks --- */

/** Every number in the board is finite and inside BOARD_LIMITS; throws a message naming the first that is not. */
export function assertSane(doc: BoardDoc, metrics: TextMetrics = estimateTextMetrics): void {
  const L = BOARD_LIMITS.coordinate
  const num = (what: string, v: number, lo = -Infinity, hi = Infinity): void => {
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} = ${v}`)
  }
  if (doc.items.length > BOARD_LIMITS.items) throw new Error(`${doc.items.length} items`)
  num('zoom', doc.view.zoom, BOARD_LIMITS.zoomMin, BOARD_LIMITS.zoomMax)
  num('view.x', doc.view.x, -L, L)
  num('view.y', doc.view.y, -L, L)
  const seen = new Set<number>()
  for (const it of doc.items) {
    const tag = `${it.kind} ${it.id}`
    if (seen.has(it.id)) throw new Error(`${tag} twice`)
    seen.add(it.id)
    if (it.id >= doc.nextId) throw new Error(`${tag} >= nextId ${doc.nextId}`)
    switch (it.kind) {
      case 'picture':
        num(`${tag}.x`, it.x, -L, L)
        num(`${tag}.y`, it.y, -L, L)
        num(`${tag}.w`, it.w, BOARD_LIMITS.pictureMin, BOARD_LIMITS.pictureMax)
        num(`${tag}.h`, it.h, BOARD_LIMITS.pictureMin, BOARD_LIMITS.pictureMax)
        num(`${tag}.rotation`, it.rotation, -180, 180)
        num(`${tag}.opacity`, it.opacity, 0.05, 1)
        for (const k of ['l', 't', 'r', 'b'] as const) num(`${tag}.crop.${k}`, it.crop[k], 0, 1)
        if (!(it.crop.r - it.crop.l >= 0.02 - 1e-9 && it.crop.b - it.crop.t >= 0.02 - 1e-9)) throw new Error(`${tag} crop too small`)
        break
      case 'note':
        num(`${tag}.x`, it.x, -L, L)
        num(`${tag}.y`, it.y, -L, L)
        num(`${tag}.w`, it.w, 16, BOARD_LIMITS.pictureMax)
        num(`${tag}.size`, it.size, 2, 2000)
        num(`${tag}.rotation`, it.rotation, -180, 180)
        if (it.text.length > BOARD_LIMITS.noteChars) throw new Error(`${tag} text ${it.text.length}`)
        if (!/^[0-9a-f]{6}$/.test(it.color)) throw new Error(`${tag} colour ${it.color}`)
        if (it.fill !== '' && !/^[0-9a-f]{6}$/.test(it.fill)) throw new Error(`${tag} fill ${it.fill}`)
        break
      case 'stroke':
        if (it.points.length < 2 || it.points.length % 2 !== 0) throw new Error(`${tag} has ${it.points.length} numbers`)
        if (it.points.length / 2 > BOARD_LIMITS.strokePoints) throw new Error(`${tag} has ${it.points.length / 2} points`)
        for (const v of it.points) num(`${tag}.point`, v, -L, L)
        num(`${tag}.width`, it.width, 0.1, 1000)
        break
      default:
        num(`${tag}.x1`, it.x1, -L, L)
        num(`${tag}.y1`, it.y1, -L, L)
        num(`${tag}.x2`, it.x2, -L, L)
        num(`${tag}.y2`, it.y2, -L, L)
        num(`${tag}.width`, it.width, 0.1, 1000)
    }
    if (it.group < 0 || !Number.isInteger(it.group)) throw new Error(`${tag} group ${it.group}`)
  }
  void metrics
}

/** The doc without its view: what undo is expected to bring back exactly. */
export function withoutView(doc: BoardDoc): Omit<BoardDoc, 'view'> {
  const { view: _view, ...rest } = doc
  return rest
}

/** mulberry32. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
