/**
 * A random walk through the controller: hundreds of mixed commands, pointer gestures (with every device, button and modifier), wheel
 * turns, keys, note edits, picture drops and outside changes, and after every step the board must be sane (no NaN, nothing past
 * BOARD_LIMITS), the selection must be ids that are on the board, and in the end undoing everything must give back the first board
 * exactly. A failure names the seed and the step, and the walk can be replayed.
 */
import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, boardToScreen, emptyBoard, type BoardDoc, type BoardItem } from '@aether/core'
import { BOARD_COMMANDS } from '../src/board/commands'
import type { BoardCommandId } from '../src/board/api'
import { Rig, VIEWPORT, assertSane, build, rng, withoutView, type PointerOpts } from './board-controller-harness'

/** Freezes a value and everything inside it: code that writes to its input then throws instead of corrupting the test's board. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

function startBoard(): BoardDoc {
  const { doc } = build((b) =>
    b
      .pic('p0', -300, -100, 200, 100)
      .pic('p1', 100, -100, 160, 240, { rotation: 25, crop: { l: 0.1, t: 0.1, r: 0.9, b: 0.8 } })
      .pic('p2', -100, 200, 300, 120, { flipH: true, opacity: 0.7 })
      .pic('p3', 400, 200, 90, 90, { gray: true })
      .note('n0', 0, 450, 240, 'a note with some words in it')
      .note('n1', -400, 350, 120, 'x', { rotation: -30, fill: '203040' })
      .stroke('s0', [200, 400, 260, 430, 300, 380], 5)
      .line('l0', -500, -300, -300, -250, 4)
      .rect('r0', 500, -300, 650, -200, '', 3)
      .mark('e0', { kind: 'ellipse', x1: 500, y1: 0, x2: 620, y2: 90, color: 'ffcc00', width: 3, fill: '112233' })
      .group('p2', 'n0')
      .lock('r0'),
  )
  return deepFreeze(doc)
}

const KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  '[',
  ']',
  '+',
  '-',
  '=',
  'Escape',
  'Delete',
  'Backspace',
  'Enter',
  'Tab',
  'Home',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  ' ',
]

interface Held {
  id: number
  x: number
  y: number
  opts: PointerOpts
}

class Walk {
  readonly r: Rig
  readonly rand: () => number
  readonly held: Held[] = []
  private nextPointer = 1
  private picturePaths = 0
  readonly start: BoardDoc
  log: string[] = []

  constructor(
    readonly seed: number,
    doc: BoardDoc,
  ) {
    this.rand = rng(seed)
    this.r = new Rig(doc, { history: { limit: 100_000 } })
    this.start = this.r.doc
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!
  }

  between(lo: number, hi: number): number {
    return lo + this.rand() * (hi - lo)
  }

  chance(p: number): boolean {
    return this.rand() < p
  }

  mods() {
    return { shift: this.chance(0.2), alt: this.chance(0.15), ctrl: this.chance(0.1), meta: this.chance(0.05) }
  }

  /** A canvas point: often on an item, sometimes on a handle, sometimes anywhere (also outside the canvas). */
  point(): { x: number; y: number } {
    const doc = this.r.doc
    const roll = this.rand()
    if (roll < 0.45 && doc.items.length > 0) {
      const it: BoardItem = this.pick(doc.items)
      const c = it.kind === 'picture' || it.kind === 'note' ? { x: it.x, y: it.y } : it.kind === 'stroke' ? { x: it.points[0] ?? 0, y: it.points[1] ?? 0 } : { x: it.x1, y: it.y1 }
      const s = boardToScreen(doc.view, VIEWPORT, c)
      return { x: s.x + this.between(-6, 6), y: s.y + this.between(-6, 6) }
    }
    const box = this.r.s.box
    if (roll < 0.6 && box) {
      const spots = [...box.corners, ...(box.rotateHandle ? [box.rotateHandle] : [])]
      const s = boardToScreen(doc.view, VIEWPORT, this.pick(spots))
      return { x: s.x + this.between(-3, 3), y: s.y + this.between(-3, 3) }
    }
    return { x: this.between(-100, VIEWPORT.w + 100), y: this.between(-100, VIEWPORT.h + 100) }
  }

  releaseHeld(cancel = false): void {
    for (const h of this.held.splice(0)) {
      if (cancel) this.r.cancel({ x: h.x, y: h.y }, h.opts)
      else this.r.up({ x: h.x, y: h.y }, h.opts)
    }
  }

  gesture(): void {
    const kind = this.rand()
    const type = this.chance(0.7) ? 'mouse' : this.chance(0.5) ? 'pen' : 'touch'
    const button = this.chance(0.88) ? 0 : this.chance(0.5) ? 1 : 2
    const id = this.nextPointer++
    const m = this.mods()
    const opts: PointerOpts = { ...m, id, button, pointerType: type, pressure: type === 'pen' ? this.between(0.01, 1) : 0.5 }
    let p = this.point()
    this.log.push(`gesture ${type} b${button} at ${p.x | 0},${p.y | 0}`)
    if (kind < 0.07) {
      // A double click.
      this.r.dblclick(p, opts)
      return
    }
    this.r.down(p, opts)
    const moves = 1 + Math.floor(this.rand() * 9)
    for (let i = 0; i < moves; i++) {
      p = this.chance(0.6) ? { x: p.x + this.between(-30, 30), y: p.y + this.between(-30, 30) } : this.point()
      this.r.move(p, { ...opts, ...(this.chance(0.3) ? this.mods() : {}), pressure: type === 'pen' ? this.between(0.01, 1) : 0.5 })
      if (this.chance(0.05)) this.op()
    }
    const end = this.rand()
    if (end < 0.1) this.r.cancel(p, opts)
    else if (end < 0.95) this.r.up(p, opts)
    else this.held.push({ id, x: p.x, y: p.y, opts })
  }

  pinch(): void {
    const a = this.nextPointer++
    const b = this.nextPointer++
    const o = (id: number): PointerOpts => ({ id, pointerType: 'touch', pressure: 0.5 })
    let pa = this.point()
    let pb = this.point()
    this.log.push('pinch')
    this.r.down(pa, o(a))
    this.r.down(pb, o(b))
    for (let i = 0; i < 6; i++) {
      pa = { x: pa.x + this.between(-60, 60), y: pa.y + this.between(-60, 60) }
      pb = { x: pb.x + this.between(-60, 60), y: pb.y + this.between(-60, 60) }
      this.r.move(pa, o(a))
      this.r.move(pb, o(b))
    }
    if (this.chance(0.5)) {
      this.r.up(pa, o(a))
      this.r.up(pb, o(b))
    } else {
      this.r.up(pb, o(b))
      this.r.up(pa, o(a))
    }
  }

  command(): void {
    const c = this.pick(BOARD_COMMANDS)
    let arg: unknown
    if (this.chance(0.2)) {
      if (c.id === 'view.background') arg = this.pick(['ff00ff', '#abcdef', 'bogus'])
      else if (c.id.startsWith('arrange.') || c.id.startsWith('sort.')) arg = this.pick([{ gap: this.between(-5, 80), columns: Math.floor(this.between(-2, 6)) }, { aspect: NaN }, 'junk', 7])
    }
    this.log.push(`exec ${c.id}`)
    this.r.c.exec(c.id as BoardCommandId, arg)
  }

  key(): void {
    const k = this.pick(KEYS)
    const m = this.mods()
    this.log.push(`key ${k} ${JSON.stringify(m)}`)
    this.r.key(k, { ...m, repeat: this.chance(0.1), down: this.chance(0.9) })
  }

  wheel(): void {
    const m = this.mods()
    this.log.push('wheel')
    this.r.wheel(this.between(-50, VIEWPORT.w + 50), this.between(-50, VIEWPORT.h + 50), this.between(-3000, 3000), {
      ...m,
      deltaX: this.chance(0.3) ? this.between(-500, 500) : 0,
      deltaMode: this.pick([0, 0, 0, 1, 2]),
    })
  }

  notes(): void {
    const roll = this.rand()
    this.log.push('notes')
    if (roll < 0.7) {
      const p = this.point()
      const id = this.r.c.addNoteAt(this.r.s.doc.view ? { x: (p.x - 500) / this.r.doc.view.zoom + this.r.doc.view.x, y: (p.y - 400) / this.r.doc.view.zoom + this.r.doc.view.y } : p)
      if (id !== 0) {
        const how = this.rand()
        if (how < 0.6) this.r.c.commitNoteText(id, this.pick(['', '  ', 'hello', 'two\nlines', 'x'.repeat(5000), '# [[not a link]] *x*']))
        else if (how < 0.8) this.r.c.cancelNoteEdit()
      }
    } else if (this.r.doc.items.length > 0) {
      const it = this.pick(this.r.doc.items)
      this.r.c.editNote(it.id)
      if (this.chance(0.7)) this.r.c.commitNoteText(it.id, this.pick(['', 'changed', 'long '.repeat(40)]))
    }
  }

  pictures(): void {
    const n = 1 + Math.floor(this.rand() * 6)
    const files = Array.from({ length: n }, () => ({
      path: `q${this.picturePaths++}.png`,
      w: this.pick([0, NaN, -4, 1, 10, 640, 4000, 1e7, this.between(50, 3000)]),
      h: this.pick([0, NaN, 3, 480, 2500, 1e7, this.between(50, 3000)]),
    }))
    this.log.push(`pictures ${n}`)
    this.r.c.addPictures(deepFreeze(files), this.chance(0.5) ? deepFreeze({ x: this.between(-2000, 2000), y: this.between(-2000, 2000) }) : undefined)
  }

  other(): void {
    const roll = this.rand()
    if (roll < 0.15) {
      this.log.push('swatches')
      this.r.c.addSwatches(deepFreeze(this.pick([['ff0000', '00ff00'], ['123456'], [], Array.from({ length: 30 }, (_, i) => (i * 8421504).toString(16).padStart(6, '0').slice(-6))])), deepFreeze({ x: this.between(-500, 500), y: this.between(-500, 500) }))
    } else if (roll < 0.35) {
      this.log.push('style')
      this.r.c.setStyle({
        color: this.pick(['ff0000', 'nope', '#00ff00']),
        width: this.pick([NaN, 0, 3, 9999, 12]),
        fill: this.pick(['', '000000', 'zz']),
        noteSize: this.pick([1, 18, 900, NaN]),
        noteColor: this.pick(['', 'ffffff', 'bad']),
        noteFill: this.pick(['', '224466']),
        arrow: this.chance(0.5),
      })
    } else if (roll < 0.5) {
      this.log.push('setView')
      this.r.c.setView({ x: this.between(-5e6, 5e6), y: this.between(-5e6, 5e6), zoom: this.pick([NaN, 0, 1e-9, 0.1, 1, 4, 1e9]) })
    } else if (roll < 0.58) {
      this.log.push('viewport')
      this.r.c.setViewport(this.pick([0, -5, 320, 1000, 1920]), this.pick([0, 240, 800, 1080]))
    } else if (roll < 0.78) {
      this.log.push('undo/redo')
      this.r.c.exec(this.chance(0.6) ? 'edit.undo' : 'edit.redo')
    } else if (roll < 0.86) {
      this.log.push('replaceDoc')
      const d = this.r.doc
      const i = Math.floor(this.rand() * d.items.length)
      const it = d.items[i]
      if (it && (it.kind === 'picture' || it.kind === 'note')) {
        const items = d.items.slice()
        items[i] = { ...it, x: it.x + 77 }
        this.r.c.replaceDoc(deepFreeze({ ...d, items }))
      }
    } else if (roll < 0.9) {
      this.log.push('markSaved')
      this.r.c.markSaved()
    } else if (roll < 0.95) {
      this.log.push('hover')
      const p = this.point()
      this.r.hover(p)
      if (this.chance(0.3)) this.r.c.pointerLeave()
      if (this.chance(0.5)) this.r.c.sampleAt(p, this.pick(['ff8800', null, 'bad']))
    } else {
      this.log.push('natural')
      const path = `q${Math.floor(this.rand() * Math.max(this.picturePaths, 1))}.png`
      const nat = this.r.c.naturalSize(path)
      // Only a size of the shape the picture is already in: a different one is a silent correction, which undo is not meant to unwind.
      if (nat) this.r.c.setNaturalSize(path, nat.w * 2, nat.h * 2)
    }
  }

  op(): void {
    if (this.held.length > 0 && this.chance(0.5)) this.releaseHeld(this.chance(0.3))
    const roll = this.rand()
    if (roll < 0.28) this.command()
    else if (roll < 0.52) this.gesture()
    else if (roll < 0.58) this.pinch()
    else if (roll < 0.7) this.key()
    else if (roll < 0.76) this.wheel()
    else if (roll < 0.82) this.notes()
    else if (roll < 0.86) this.pictures()
    else this.other()
  }

  /** What must hold after every step. */
  check(): void {
    const { r } = this
    const s = r.s
    assertSane(s.doc)
    const ids = new Set(s.doc.items.map((i) => i.id))
    for (const id of s.selection) expect(ids.has(id), `selected ${id} is on the board`).toBe(true)
    // In board order, once each, and whole groups.
    const order = s.doc.items.filter((i) => s.selection.includes(i.id)).map((i) => i.id)
    expect(s.selection).toEqual(order)
    const groups = new Set(s.doc.items.filter((i) => s.selection.includes(i.id) && i.group > 0).map((i) => i.group))
    for (const it of s.doc.items) if (it.group > 0 && groups.has(it.group)) expect(s.selection.includes(it.id), `group member ${it.id} selected`).toBe(true)
    if (s.editingNote !== null) expect(s.doc.items.find((i) => i.id === s.editingNote)?.kind).toBe('note')
    if (s.cropping !== null) {
      expect(s.doc.items.find((i) => i.id === s.cropping)?.kind).toBe('picture')
      expect(s.tool).toBe('crop')
    }
    if (s.box) for (const p of [...s.box.corners, ...(s.box.rotateHandle ? [s.box.rotateHandle] : [])]) expect(Number.isFinite(p.x + p.y)).toBe(true)
    if (s.marquee) expect(Number.isFinite(s.marquee.x + s.marquee.y + s.marquee.w + s.marquee.h)).toBe(true)
    if (s.draft && s.draft.kind === 'stroke') expect(s.draft.points.length / 2).toBeLessThanOrEqual(BOARD_LIMITS.strokePoints)
    if (s.sample) expect(/^[0-9a-f]{6}$/.test(s.sample.hex)).toBe(true)
    expect(Number.isFinite(s.viewport.w + s.viewport.h)).toBe(true)
    expect(s.viewport.w).toBeGreaterThan(0)
    for (const g of [...s.guides.v, ...s.guides.h]) expect(Number.isFinite(g)).toBe(true)
  }
}

describe('a random walk through the controller', () => {
  const run = (seed: number, steps: number, doc: BoardDoc): void => {
    const w = new Walk(seed, doc)
    for (let i = 0; i < steps; i++) {
      try {
        w.op()
        w.check()
      } catch (err) {
        const recent = w.log.slice(-8).join(' | ')
        throw new Error(`seed ${seed} step ${i}: ${(err as Error).message}\nlast: ${recent}`, { cause: err })
      }
    }
    // Finish what is under way, then undo everything.
    w.releaseHeld()
    w.r.c.cancelNoteEdit()
    w.r.key('Escape')
    w.r.key('Escape')
    w.check()
    let guard = 0
    while (w.r.s.canUndo && guard++ < 100_000) w.r.c.exec('edit.undo')
    expect(w.r.s.canUndo).toBe(false)
    expect(withoutView(w.r.doc)).toEqual(withoutView(w.start))
    while (w.r.s.canRedo && guard++ < 200_000) w.r.c.exec('edit.redo')
    w.check()
  }

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`300 steps, seed ${seed}: sane throughout, the selection on the board, and undo returns the first board`, () => {
      run(seed, 300, startBoard())
    })
  }

  it('on an empty board, seed 21', () => {
    run(21, 300, emptyBoard('empty'))
  })

  it('1500 steps, seed 99', () => {
    run(99, 1500, startBoard())
  })

  it('is deterministic: the same seed leaves the same board', () => {
    const a = new Walk(5, startBoard())
    const b = new Walk(5, startBoard())
    for (let i = 0; i < 200; i++) {
      a.op()
      b.op()
    }
    expect(a.r.doc).toEqual(b.r.doc)
    expect(a.r.s.selection).toEqual(b.r.s.selection)
  })
})
