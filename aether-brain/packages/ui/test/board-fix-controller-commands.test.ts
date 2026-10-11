/**
 * Review fixes in the controller's commands: copying between boards through the system clipboard (controller-commands-1, -m6), outside
 * changes as a barrier (controller-commands-m2, geometry-m8, geometry-m3), a picture's own size known for sure or not (geometry-m5),
 * arranging one item (geometry-m4, controller-commands-m9), the small ones (controller-commands-m13), the quarter turn of a frame
 * (geometry-1) and 100% on a picture shown very small (controller-commands-m10).
 */
import { describe, expect, it } from 'vitest'
import {
  BOARD_LIMITS,
  addNote,
  boardChars,
  emptyBoard,
  itemBounds,
  estimateTextMetrics,
  parseBoard,
  serializeBoard,
  type BoardDoc,
  type EllipseItem,
  type NoteItem,
  type PictureItem,
  type RectItem,
  type StrokeItem,
} from '@aether/core'
import { Rig, at, build, fatBoard, threeThings } from './board-controller-harness'

const M = estimateTextMetrics
const pic = (r: Rig, id: number): PictureItem => r.item<PictureItem>(id)
const HEAD = /^Aether Brain board: (\d+) items? copied\n/

function mixed() {
  return build((b) =>
    b
      .pic('a', -300, 0, 200, 100, { caption: 'first' })
      .pic('b', 100, 0, 200, 100, { rotation: 30, crop: { l: 0.1, t: 0, r: 0.8, b: 1 } })
      .note('n', 0, 250, 240, 'a note with [[brackets]] and #tags', { fill: 'ffee00' })
      .stroke('s', [0, 400, 30, 430, 60, 400], 5)
      .rect('r', 200, 300, 300, 380, '112233', 3)
      .group('a', 'n'),
  )
}

/* -------------------------------------------------------------------------- the system clipboard --- */

describe('copying through the system clipboard', () => {
  it('exports the copied items as a line the user can read and a small board note', () => {
    const { doc } = mixed()
    const r = new Rig(doc)
    expect(r.c.exportCopy()).toBeNull()
    r.c.exec('edit.selectAll')
    r.c.exec('edit.copy')
    const out = r.c.exportCopy()!
    expect(out.count).toBe(5)
    expect(out.text).toMatch(HEAD)
    expect(HEAD.exec(out.text)![1]).toBe('5')
    const board = parseBoard(out.text.replace(HEAD, '')).doc
    expect(board.items).toHaveLength(5)
    expect(board.items.map((i) => i.kind)).toEqual(['picture', 'picture', 'note', 'stroke', 'rect'])
  })

  it('says "1 item" for one', () => {
    const { doc } = mixed()
    const r = new Rig(doc)
    r.click(at(100, 0))
    r.c.exec('edit.copy')
    expect(r.c.exportCopy()!.text.startsWith('Aether Brain board: 1 item copied\n')).toBe(true)
  })

  it('pastes into another board, another controller, with new ids, as one step, selected, centred on the view', () => {
    const { doc } = mixed()
    const from = new Rig(doc)
    from.c.exec('edit.selectAll')
    from.c.exec('edit.copy')
    const copied = from.c.exportCopy()!

    const { doc: other } = build((b) => b.pic('x', 5000, 5000, 100, 100))
    const to = new Rig(other)
    to.c.setView({ x: 5000, y: 5000, zoom: 1 })
    to.forget()
    expect(to.c.importCopy(copied.text)).toBe(5)
    expect(to.doc.items).toHaveLength(6)
    expect(to.doc.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(to.s.undoLabel).toBe('Paste')
    expect(to.s.selection).toEqual([2, 3, 4, 5, 6])
    const fresh = to.doc.items.slice(1)
    const b = itemBounds(fresh[0]!, M)
    expect(fresh.map((i) => i.kind)).toEqual(['picture', 'picture', 'note', 'stroke', 'rect'])
    expect((fresh[0] as PictureItem).caption).toBe('first')
    expect((fresh[1] as PictureItem).crop).toEqual({ l: 0.1, t: 0, r: 0.8, b: 1 })
    expect((fresh[2] as NoteItem).text).toBe('a note with [[brackets]] and #tags')
    expect((fresh[2] as NoteItem).fill).toBe('ffee00')
    void b
    // The middle of what came in is the middle of the view.
    const xs = fresh.map((i) => itemBounds(i, M))
    const left = Math.min(...xs.map((q) => q.x))
    const right = Math.max(...xs.map((q) => q.x + q.w))
    const top = Math.min(...xs.map((q) => q.y))
    const bottom = Math.max(...xs.map((q) => q.y + q.h))
    expect((left + right) / 2).toBeCloseTo(5000, 3)
    expect((top + bottom) / 2).toBeCloseTo(5000, 3)
    // The group stays a group (two members), as a new one.
    const groups = fresh.filter((i) => i.group > 0)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.group).toBe(groups[1]!.group)
    to.c.exec('edit.undo')
    expect(to.doc.items).toHaveLength(1)
  })

  it('pastes at a given point, and a second paste on the same spot fans out like a paste of the board\'s own items', () => {
    const { doc } = mixed()
    const from = new Rig(doc)
    from.click(at(100, 0))
    from.c.exec('edit.copy')
    const copied = from.c.exportCopy()!
    const to = new Rig(emptyBoard('t'))
    to.c.importCopy(copied.text, { x: 700, y: 600 })
    to.c.importCopy(copied.text, { x: 700, y: 600 })
    const [p1, p2] = to.doc.items as PictureItem[]
    expect(p1!.x).toBeCloseTo(700, 6)
    expect(p1!.y).toBeCloseTo(600, 6)
    expect(p2!.x).toBeGreaterThan(p1!.x)
    expect(p2!.y).toBeGreaterThan(p1!.y)
  })

  it('exports nothing when the last copy or cut stored nothing: the system clipboard is left as it is', () => {
    const { doc } = mixed()
    const r = new Rig(doc)
    r.click(at(100, 0))
    r.c.exec('edit.copy')
    expect(r.c.exportCopy()).not.toBeNull()
    // Nothing selected: Ctrl+C stores nothing, and must not hand the old items out again.
    r.c.exec('edit.selectNone')
    r.c.exec('edit.copy')
    expect(r.c.exportCopy()).toBeNull()
    // The board's own paste still has the earlier copy.
    expect(r.s.canPaste).toBe(true)
    // Cut of locked items only.
    const locked = new Rig(build((b) => b.pic('a', 0, 0, 100, 100).lock('a')).doc)
    locked.c.exec('edit.selectAll')
    locked.c.exec('edit.cut')
    expect(locked.c.exportCopy()).toBeNull()
    expect(locked.doc.items).toHaveLength(1)
  })

  it('exports what a cut took', () => {
    const { doc } = mixed()
    const r = new Rig(doc)
    r.click(at(100, 0))
    r.c.exec('edit.cut')
    expect(r.doc.items).toHaveLength(4)
    expect(r.c.exportCopy()!.count).toBe(1)
  })

  it('what is not a copy from a board is left alone: null, nothing pasted', () => {
    const r = new Rig(emptyBoard('t'))
    r.forget()
    for (const text of ['', 'hello', 'Aether Brain board: lots of items copied\nx', ' Aether Brain board: 2 items copied\n', 'aether brain board: 2 items copied\n', 'Aether Brain board: 2 items copied']) {
      expect(r.c.importCopy(text), text).toBeNull()
    }
    expect(r.doc.items).toHaveLength(0)
    expect(r.events).toHaveLength(0)
  })

  it('a copy that cannot be read says so and pastes nothing (it never becomes a note)', () => {
    const r = new Rig(emptyBoard('t'))
    r.forget()
    expect(r.c.importCopy('Aether Brain board: 3 items copied\nthis is not a board at all')).toBe(0)
    expect(r.c.importCopy('Aether Brain board: 3 items copied\n')).toBe(0)
    expect(r.doc.items).toHaveLength(0)
    expect(r.toasts()).toHaveLength(2)
    expect(r.s.canUndo).toBe(false)
  })

  it('reads the line breaks of Windows', () => {
    const { doc } = mixed()
    const from = new Rig(doc)
    from.c.exec('edit.selectAll')
    from.c.exec('edit.copy')
    const crlf = from.c.exportCopy()!.text.replace(/\n/g, '\r\n')
    const to = new Rig(emptyBoard('t'))
    expect(to.c.importCopy(crlf)).toBe(5)
  })

  it('takes only the items: the frontmatter, headings and prose of the text are not read, and a hostile text is cut by the board reader\'s limits', () => {
    const lines = Array.from({ length: BOARD_LIMITS.items + 300 }, (_, i) => `- note x=${i} y=0 w=100 size=12 color=ffffff fill= r=0 » n${i}`)
    const text = `Aether Brain board: 9 items copied\n---\ntitle: Evil\ntype: project\n---\n# Heading\n[[link]] #tag\n\n## Board\n\n- view x=1 y=1 zoom=3 bg=ff0000 gray=1 smooth=0 captions=1 grid=99\n${lines.join('\n')}\n`
    const r = new Rig(emptyBoard('mine'))
    const before = r.doc
    const n = r.c.importCopy(text)
    // The reader keeps the first BOARD_LIMITS.items, and the board takes them in only when all fit: here they do not (the cap is the same).
    expect(n === BOARD_LIMITS.items || n === 0).toBe(true)
    expect(r.doc.title).toBe(before.title)
    expect(r.doc.bg).toBe(before.bg)
    expect(r.doc.gray).toBe(before.gray)
    expect(r.doc.view).toEqual(before.view)
    expect(r.doc.items.length).toBeLessThanOrEqual(BOARD_LIMITS.items)
    expect(r.doc.extra).toEqual([])
  })

  it('refuses a text far bigger than a board can be, without reading it', () => {
    const r = new Rig(emptyBoard('t'))
    r.forget()
    const huge = 'Aether Brain board: 1 item copied\n' + 'x'.repeat(2 * BOARD_LIMITS.noteTotal + 10)
    expect(r.c.importCopy(huge)).toBe(0)
    expect(r.doc.items).toHaveLength(0)
    expect(r.toasts()).toHaveLength(1)
  })

  it('obeys the item cap and the character budget of the board it lands on', () => {
    const { doc } = mixed()
    const from = new Rig(doc)
    from.c.exec('edit.selectAll')
    from.c.exec('edit.copy')
    const copied = from.c.exportCopy()!
    const crowded = new Rig(build((b) => { for (let i = 0; i < BOARD_LIMITS.items - 2; i++) b.line(`l${i}`, i, 0, i + 1, 5) }).doc)
    crowded.forget()
    expect(crowded.c.importCopy(copied.text)).toBe(0)
    expect(crowded.toasts('limit')).toHaveLength(1)
    expect(crowded.doc.items).toHaveLength(BOARD_LIMITS.items - 2)
    const heavy = new Rig(fatBoard(BOARD_LIMITS.noteTotal - 100))
    heavy.forget()
    expect(heavy.c.importCopy(copied.text)).toBe(0)
    expect(heavy.toasts('limit')).toHaveLength(1)
  })

  it('never throws, whatever it is given', () => {
    const r = new Rig(emptyBoard('t'))
    for (const x of [undefined, null, 5, {}, [], 'Aether Brain board: 1 item copied\n\u0000￿', 'Aether Brain board: 1 item copied\n## Board\n- note x=NaN y=Infinity » \\']) {
      expect(() => r.c.importCopy(x as unknown as string, { x: NaN, y: 1 })).not.toThrow()
    }
  })

  it('the same-session paste does not need the system clipboard', () => {
    const { doc } = mixed()
    const r = new Rig(doc)
    r.click(at(100, 0))
    r.c.exec('edit.copy')
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(6)
  })
})

/* -------------------------------------------------------------------------- an outside change --- */

describe('an outside change', () => {
  it('is a barrier for the undo: Ctrl+Z does not take back what another program wrote', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(100, -100))
    r.key('ArrowRight')
    expect(r.s.canUndo).toBe(true)
    const outside: BoardDoc = addNote({ ...r.doc, items: r.doc.items }, { text: 'from sync', x: 0, y: 600 }).doc
    r.c.replaceDoc(outside)
    expect(r.doc.items).toHaveLength(4)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.canRedo).toBe(false)
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(4)
    expect(r.doc.items.some((i) => i.kind === 'note' && i.text === 'from sync')).toBe(true)
    expect(id.a).toBeGreaterThan(0)
    // New work after it is undoable, back to the outside board and no further.
    r.click(at(100, -100))
    r.key('ArrowDown')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(4)
    expect(r.s.canUndo).toBe(false)
  })

  it('keeps the selection only for items that are exactly what they were at the same id', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    // A sync tool inserted a note at the top of the board section: every id shifts by one.
    const inserted = addNote(emptyBoard('x'), { text: 'new first', x: 0, y: 700 }).doc.items[0]!
    const shifted = { ...doc, items: [inserted, ...doc.items].map((it, i) => ({ ...it, id: i + 1 })), nextId: 5 }
    r.c.replaceDoc(shifted)
    expect(r.doc.items).toHaveLength(4)
    expect(r.s.selection).toEqual([])
    expect(id.a).toBe(1)
  })

  it('keeps it when the outside board is the same except for something else', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.replaceDoc({ ...doc, bg: 'ffffff' })
    expect(r.doc.bg).toBe('ffffff')
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
  })

  it('leaves the crop of a picture that changed', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('tool.crop')
    expect(r.s.cropping).toBe(id.a)
    r.c.replaceDoc({ ...doc, items: doc.items.map((i) => (i.id === id.a && i.kind === 'picture' ? { ...i, x: 0 } : i)) })
    expect(r.s.cropping).toBeNull()
    expect(r.s.tool).toBe('select')
  })
})

/* -------------------------------------------------------------------------- a picture's own size --- */

describe('a picture\'s own size', () => {
  const files = [{ path: 'Boards/Gate/a.png', w: 1024, h: 512 }]

  it('is not known for sure from a preview: Reset size leaves such a picture as it is and says how many', () => {
    const r = new Rig(emptyBoard('t'))
    const [id] = r.c.addPictures(files)
    const before = pic(r, id!)
    r.forget()
    r.c.exec('transform.resetScale')
    expect(pic(r, id!)).toBe(before)
    expect(r.s.canUndo).toBe(true)
    const said = r.toasts('select')
    expect(said).toHaveLength(1)
    expect((said[0] as { text: string }).text).toMatch(/^1 picture was left as it was/)
  })

  it('is known for sure once the picture itself has been read: Reset size, Show at own size and 100% use it', () => {
    const r = new Rig(emptyBoard('t'))
    const [id] = r.c.addPictures(files)
    r.c.setNaturalSize('Boards/Gate/a.png', 4000, 2000)
    expect(r.c.exactNaturalSize('Boards/Gate/a.png')).toEqual({ w: 4000, h: 2000 })
    r.forget()
    r.c.exec('transform.resetScale')
    expect(pic(r, id!)).toMatchObject({ w: 4000, h: 2000 })
    expect(r.toasts('select')).toHaveLength(0)
    r.c.exec('view.zoom100')
    expect(r.doc.view.zoom).toBeCloseTo(1, 9)
  })

  it('a pixel size given as exact is trusted at once, and a preview shape never replaces an exact size', () => {
    const r = new Rig(emptyBoard('t'))
    const [id] = r.c.addPictures([{ path: 'x.png', w: 3000, h: 1500, exact: true }])
    expect(r.c.exactNaturalSize('x.png')).toEqual({ w: 3000, h: 1500 })
    r.c.addPictures([{ path: 'x.png', w: 1024, h: 512 }])
    expect(r.c.exactNaturalSize('x.png')).toEqual({ w: 3000, h: 1500 })
    expect(r.c.naturalSize('x.png')).toEqual({ w: 3000, h: 1500 })
    r.c.exec('edit.selectNone')
    r.click(at(0, 0))
    expect(r.s.selection.length).toBeGreaterThan(0)
    void id
  })

  it('Show at the pictures\' own size skips the unknown ones and counts them', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.addPictures([
      { path: 'one.png', w: 1024, h: 512 },
      { path: 'two.png', w: 1024, h: 512 },
      { path: 'three.png', w: 800, h: 800 },
    ])
    r.c.setNaturalSize('two.png', 2048, 1024)
    r.forget()
    r.c.exec('edit.selectAll')
    r.c.exec('normalize.scale')
    const text = (r.toasts('select')[0] as { text: string }).text
    expect(text).toMatch(/^2 pictures were left as they were/)
    const two = r.doc.items.find((i) => i.kind === 'picture' && i.path === 'two.png') as PictureItem
    expect(two.w).toBe(2048)
  })

  it('100% on a picture whose size is not known zooms to 1 and says why', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.addPictures(files)
    r.c.setView({ x: 3, y: 4, zoom: 2.5 })
    r.forget()
    r.c.exec('view.zoom100')
    expect(r.doc.view.zoom).toBe(1)
    expect(r.toasts('select')).toHaveLength(1)
  })

  it('100% on a picture shown very small says that it cannot be reached, and goes as far as it can', () => {
    const { doc } = build((b) => b.pic('tiny', 0, 0, 8, 8))
    const r = new Rig(doc)
    r.c.setNaturalSize('tiny.png', 4000, 4000)
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.exec('view.zoom100')
    expect(r.doc.view.zoom).toBe(BOARD_LIMITS.zoomMax)
    const said = r.toasts('select')
    expect(said).toHaveLength(1)
    expect((said[0] as { text: string }).text).toMatch(/out of reach/)
    expect((said[0] as { text: string }).text).toMatch(/500/)
  })

  it('100% that can be reached says nothing', () => {
    const { doc } = build((b) => b.pic('ok', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setNaturalSize('ok.png', 400, 400)
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.exec('view.zoom100')
    expect(r.doc.view.zoom).toBe(4)
    expect(r.events).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- arranging --- */

describe('arrange and sort with one item selected', () => {
  it('do nothing but say what they need', () => {
    const { doc } = build((b) => b.pic('a', -300, 0, 100, 100).pic('b', 300, 200, 100, 100).note('n', 0, 400, 100, 'x'))
    for (const id of ['arrange.row', 'arrange.column', 'arrange.optimal', 'sort.name', 'sort.shuffle'] as const) {
      const r = new Rig(doc)
      r.click(at(-300, 0))
      r.forget()
      r.c.exec(id)
      expect(r.doc.items, id).toBe(doc.items)
      expect(r.s.canUndo, id).toBe(false)
      const said = r.toasts('select')
      expect(said, id).toHaveLength(1)
      expect((said[0] as { text: string }).text).toBe('Select two or more items (or none, for the whole board).')
    }
  })

  it('still arrange the selection of two, and the whole board when nothing is selected', () => {
    const { doc, id } = build((b) => b.pic('a', -300, 0, 100, 100).pic('b', 300, 200, 100, 100).pic('c', 900, -400, 100, 100))
    const some = new Rig(doc)
    some.click(at(-300, 0))
    some.click(at(300, 200), { shift: true })
    some.c.exec('arrange.row')
    expect(pic(some, id.c).x).toBe(900)
    expect(pic(some, id.a).y).toBeCloseTo(pic(some, id.b).y, 9)
    const none = new Rig(doc)
    none.c.exec('arrange.row')
    expect(pic(none, id.c).x).not.toBe(900)
  })
})

/* -------------------------------------------------------------------------- the small ones --- */

describe('lock, cut and the grid', () => {
  it('Lock on items that are all locked already says nothing', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.exec('edit.lock')
    expect(r.events).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
    // A change that really is refused still says so.
    r.c.exec('edit.delete')
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('Lock still locks free items', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.lock')
    expect(r.doc.items.every((i) => i.locked)).toBe(true)
  })

  it('Cut with some locked items cuts the free ones and says how many stayed', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).pic('c', 600, 0, 100, 100).lock('a', 'b'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.exec('edit.cut')
    expect(r.doc.items).toHaveLength(2)
    const text = r.toasts().map((t) => (t as { text: string }).text)
    expect(text).toEqual(['2 locked items were not cut.'])
  })

  it('snapping remembers the grid the board had', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig({ ...doc, grid: 40 })
    r.c.exec('view.gridSnap')
    expect(r.doc.grid).toBe(0)
    r.c.exec('view.gridSnap')
    expect(r.doc.grid).toBe(40)
    // A board without a grid gets the usual 16.
    const plain = new Rig(doc)
    plain.c.exec('view.gridSnap')
    expect(plain.doc.grid).toBe(16)
    // A grid that arrives from outside is remembered too.
    plain.c.exec('view.gridSnap')
    plain.c.replaceDoc({ ...plain.doc, grid: 24 })
    plain.c.exec('view.gridSnap')
    plain.c.exec('view.gridSnap')
    expect(plain.doc.grid).toBe(24)
  })
})

describe('a quarter turn', () => {
  it('turns a frame round a picture with it', () => {
    const { doc, id } = build((b) => b.pic('p', 0, 0, 400, 200).rect('f', -212, -112, 212, 112, '', 4).group('p', 'f'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('transform.rotateCw')
    const p = pic(r, id.p)
    const f = r.item<RectItem>(id.f)
    expect(p.rotation).toBe(90)
    const pb = itemBounds(p, M)
    const fb = itemBounds(f, M)
    // The frame (stroke included) still encloses the picture, with the same margin.
    expect(fb.x).toBeLessThan(pb.x)
    expect(fb.y).toBeLessThan(pb.y)
    expect(fb.x + fb.w).toBeGreaterThan(pb.x + pb.w)
    expect(fb.y + fb.h).toBeGreaterThan(pb.y + pb.h)
    expect(Math.abs(f.x2 - f.x1)).toBeCloseTo(224, 6)
    expect(Math.abs(f.y2 - f.y1)).toBeCloseTo(424, 6)
    // Four turns bring everything back.
    r.c.exec('transform.rotateCw')
    r.c.exec('transform.rotateCw')
    r.c.exec('transform.rotateCw')
    const g = r.item<RectItem>(id.f)
    expect(Math.abs(g.x2 - g.x1)).toBeCloseTo(424, 6)
    expect(Math.abs(g.y2 - g.y1)).toBeCloseTo(224, 6)
  })

  it('counter-clockwise too, and for an ellipse', () => {
    const { doc, id } = build((b) => b.pic('p', 0, 0, 400, 200).mark('e', { kind: 'ellipse', x1: -300, y1: -150, x2: 300, y2: 150, color: 'ff0000', width: 4, fill: '' }).group('p', 'e'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('transform.rotateCcw')
    const e = r.item<EllipseItem>(id.e)
    expect(Math.abs(e.x2 - e.x1)).toBeCloseTo(300, 6)
    expect(Math.abs(e.y2 - e.y1)).toBeCloseTo(600, 6)
  })

  it('a drag of the rotate handle still leaves shapes upright (the box would otherwise jump at each quarter turn)', () => {
    const { doc, id } = build((b) => b.pic('p', 0, 0, 400, 200).rect('f', -212, -112, 212, 112, '', 4).group('p', 'f'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    const handle = r.s.box!.rotateHandle!
    r.drag(at(handle.x, handle.y), at(400, 0), {}, 6)
    const f = r.item<RectItem>(id.f)
    expect(Math.abs(f.x2 - f.x1)).toBeCloseTo(424, 6)
    expect(Math.abs(f.y2 - f.y1)).toBeCloseTo(224, 6)
  })
})

describe('the note being typed', () => {
  it('is never in a history step of another change', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.note')
    r.click(at(300, 500))
    expect(r.s.editingNote).not.toBeNull()
    // A command computed on the board that holds the empty note must not take it along.
    r.c.exec('view.gray')
    expect(r.doc.items.every((i) => !(i.kind === 'note' && i.text === ''))).toBe(true)
    expect(r.s.editingNote).toBeNull()
    r.c.exec('edit.undo')
    expect(r.doc.gray).toBe(false)
    expect(r.doc.items).toHaveLength(3)
  })

  it('is part of the size the status shows', () => {
    const r = new Rig(emptyBoard('t'))
    const before = r.s.chars
    r.c.addNoteAt({ x: 0, y: 0 })
    expect(r.s.chars).toBeGreaterThan(before)
    expect(r.s.chars).toBe(boardChars(r.doc))
  })
})

describe('the notes of the board as a note holds them', () => {
  it('a board copied out and back in is the same work', () => {
    const { doc } = mixed()
    const a = new Rig(doc)
    a.c.exec('edit.selectAll')
    a.c.exec('edit.copy')
    const text = a.c.exportCopy()!.text
    const b = new Rig(emptyBoard('t'))
    b.c.importCopy(text, { x: 0, y: 0 })
    const again = new Rig(emptyBoard('t'))
    b.c.exec('edit.selectAll')
    b.c.exec('edit.copy')
    again.c.importCopy(b.c.exportCopy()!.text, { x: 0, y: 0 })
    expect(again.doc.items.map((i) => i.kind)).toEqual(b.doc.items.map((i) => i.kind))
    const note = again.doc.items.find((i) => i.kind === 'note') as NoteItem
    expect(note.text).toBe('a note with [[brackets]] and #tags')
    const stroke = again.doc.items.find((i) => i.kind === 'stroke') as StrokeItem
    expect(stroke.points).toHaveLength(6)
    const written = serializeBoard(again.doc, undefined, new Date('2026-01-01T00:00:00Z'))
    expect(parseBoard(written).doc.items).toHaveLength(5)
  })
})
