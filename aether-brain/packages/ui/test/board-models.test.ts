import { describe, expect, it } from 'vitest'
import { MODEL_VIEW_DEFAULT, serializeBoard, parseBoard, type PictureItem } from '@aether/core'
import { BOARD_COMMANDS, keyToCommand } from '../src/board/commands'
import { Rig, at, build } from './board-controller-harness'

/**
 * A 3D model on a board is turned with the Turn tool (M): a drag on the model turns it, a drag to the right turns it to the right and
 * a drag down tips its top toward you, and the view it is left in is part of the board (one step of the history, saved in the note).
 */

/** A board of one model, one picture and one locked model, the picture and the models far apart. */
function board() {
  return build((b) =>
    b
      .pic('robot', 0, 0, 300, 300, { path: 'Art/robot.glb' })
      .pic('gate', -500, 0, 200, 200, { path: 'Art/gate.png' })
      .pic('fixed', 500, 0, 200, 200, { path: 'Art/fixed.glb' })
      .lock('fixed'),
  )
}

const turnOf = (r: Rig, id: number) => r.item<PictureItem>(id).turn

describe('the Turn tool', () => {
  it('is picked with M or its command, and Esc goes back to the select tool', () => {
    const { doc } = board()
    const r = new Rig(doc)
    r.key('m')
    expect(r.s.tool).toBe('turn')
    r.key('Escape')
    expect(r.s.tool).toBe('select')
    r.c.exec('tool.turn')
    expect(r.s.tool).toBe('turn')
    expect(keyToCommand({ key: 'm', code: 'KeyM', down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false }, { tool: 'select', editing: false, cropping: false })).toBe('tool.turn')
    expect(keyToCommand({ key: 'Escape', code: 'Escape', down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false }, { tool: 'turn', editing: false, cropping: false })).toBe('tool.select')
    // Another key does not leave it.
    expect(keyToCommand({ key: 'Enter', code: 'Enter', down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false }, { tool: 'turn', editing: false, cropping: false })).not.toBe('tool.select')
  })

  it('has a row in the table, in the tools, with the key M and no need of a selection', () => {
    const row = BOARD_COMMANDS.find((c) => c.id === 'tool.turn')!
    expect(row).toMatchObject({ group: 'Tools', keys: 'M' })
    expect(row.needs).toBeUndefined()
    expect(BOARD_COMMANDS.filter((c) => c.keys === 'M')).toHaveLength(1)
  })

  it('turns a model to the right when it is dragged to the right: 0.5 degrees a pixel, from the view it had', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(100, 0))
    // The camera goes the other way round: yaw 35 less 50.
    expect(turnOf(r, id.robot)).toEqual({ yaw: 345, pitch: MODEL_VIEW_DEFAULT.pitch })
    expect(r.s.selection).toEqual([id.robot])
    // Dragging left from there turns it back and on: 345 + 120 = 465 → 105.
    r.drag(at(0, 0), at(-240, 0))
    expect(turnOf(r, id.robot)).toEqual({ yaw: 105, pitch: MODEL_VIEW_DEFAULT.pitch })
  })

  it('tips the model toward you when it is dragged down, and holds the pitch to ±89', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(0, 40))
    expect(turnOf(r, id.robot)).toEqual({ yaw: 35, pitch: 44 })
    r.drag(at(0, 0), at(0, 300))
    expect(turnOf(r, id.robot)).toEqual({ yaw: 35, pitch: 89 })
    r.drag(at(0, -100), at(0, 300))
    expect(turnOf(r, id.robot)?.pitch).toBe(89)
    r.drag(at(0, 100), at(0, -400))
    expect(turnOf(r, id.robot)).toEqual({ yaw: 35, pitch: -89 })
  })

  it('follows the pointer while it drags: the board changes with every move, from where the press began, however far it wanders', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.down(at(0, 0))
    r.move(at(40, 0))
    expect(turnOf(r, id.robot)?.yaw).toBe(15)
    r.move(at(-40, 0))
    expect(turnOf(r, id.robot)?.yaw).toBe(55)
    r.move(at(0, 0))
    // Back where the press began: the first view again, which a model keeps no word about.
    expect(r.item(id.robot)).not.toHaveProperty('turn')
    r.up(at(0, 0))
    expect(r.s.canUndo).toBe(false)
  })

  it('is one step of the history, named Turn, and an undo puts the model back', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(200, 80), {}, 12)
    expect(r.s.undoLabel).toBe('Turn')
    expect(turnOf(r, id.robot)).toEqual({ yaw: -65 + 360, pitch: 64 })
    r.c.exec('edit.undo')
    expect(r.item(id.robot)).not.toHaveProperty('turn')
    expect(r.s.canUndo).toBe(false)
    r.c.exec('edit.redo')
    expect(turnOf(r, id.robot)).toEqual({ yaw: 295, pitch: 64 })
  })

  it('moves nothing: the model stays where it is, the same size and angle, and the other items are untouched', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(150, 90))
    const robot = r.item<PictureItem>(id.robot)
    expect(robot).toMatchObject({ x: 0, y: 0, w: 300, h: 300, rotation: 0 })
    expect(r.item(id.gate)).toBe(doc.items.find((i) => i.id === id.gate))
  })

  it('does nothing on a picture that is not a model, or on empty canvas, and says what it wants', () => {
    const { doc } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(-500, 0), at(-400, 0))
    expect(r.doc).toBe(doc)
    expect(r.toasts('select').map((e) => (e.type === 'toast' ? e.text : ''))).toEqual(['Click a 3D model to turn it.'])
    r.drag(at(0, 600), at(100, 600))
    expect(r.doc).toBe(doc)
    expect(r.s.selection).toEqual([])
  })

  it('does nothing to a model that is locked, and says so', () => {
    const { doc } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(500, 0), at(600, 0))
    expect(r.doc).toBe(doc)
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('takes a model on top when two overlap, and the one it presses is the one that is selected', () => {
    const { doc, id } = build((b) => b.pic('under', 0, 0, 300, 300, { path: 'Art/under.glb' }).pic('over', 0, 0, 300, 300, { path: 'Art/over.glb' }))
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(20, 0))
    expect(r.s.selection).toEqual([id.over])
    expect(r.item(id.under)).not.toHaveProperty('turn')
    expect(turnOf(r, id.over)?.yaw).toBe(25)
  })

  it('stays in the tool after a drag, and a drag cancelled with Esc leaves the model as it was', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(20, 0))
    expect(r.s.tool).toBe('turn')
    r.down(at(0, 0))
    r.move(at(100, 0))
    expect(turnOf(r, id.robot)?.yaw).toBe(335)
    r.key('Escape')
    expect(turnOf(r, id.robot)).toEqual({ yaw: 25, pitch: 24 })
    r.up(at(100, 0))
    expect(turnOf(r, id.robot)).toEqual({ yaw: 25, pitch: 24 })
  })

  it('shows a grab hand in the tool and a grabbing one during the drag', () => {
    const { doc } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    expect(r.s.cursor).toBe('grab')
    r.down(at(0, 0))
    r.move(at(10, 0))
    expect(r.s.cursor).toBe('grabbing')
    r.up(at(10, 0))
  })
})

describe('resetting a model’s view', () => {
  it('puts a turned model back to its first view in one step, and a model nobody turned stays as it is', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(100, 100))
    expect(turnOf(r, id.robot)).toBeDefined()
    r.c.exec('tool.select')
    r.c.exec('transform.resetView')
    expect(r.item(id.robot)).not.toHaveProperty('turn')
    expect(r.s.undoLabel).toBe('Reset view')
    r.c.exec('edit.undo')
    expect(turnOf(r, id.robot)).toBeDefined()
  })

  it('says what it needs when what is selected is no model, and changes nothing', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.click(at(-500, 0))
    expect(r.s.selection).toEqual([id.gate])
    r.forget()
    r.c.exec('transform.resetView')
    expect(r.doc).toBe(doc)
    expect(r.toasts('select').map((e) => (e.type === 'toast' ? e.text : ''))).toEqual(['Select a 3D model to reset its view.'])
  })

  it('is part of Reset (rotation, size, crop, flips, opacity)', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(60, 60))
    r.c.exec('tool.select')
    r.c.exec('transform.resetAll')
    expect(r.item(id.robot)).not.toHaveProperty('turn')
  })

  it('leaves a locked model alone', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.click(at(500, 0))
    expect(r.s.selection).toEqual([id.fixed])
    r.c.exec('transform.resetView')
    expect(r.doc).toBe(doc)
  })
})

describe('what a turned model leaves in the note', () => {
  it('is yaw= and pitch= on its line, read back as the same view, and a model nobody turned has none', () => {
    const { doc, id } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.drag(at(0, 0), at(-90, 30))
    const raw = serializeBoard(r.doc, undefined, new Date(2026, 9, 23, 20, 0, 0))
    const line = raw.split('\n').find((l) => l.includes('Art/robot.glb'))!
    expect(line).toMatch(/^- pic Art\/robot\.glb x=0 y=0 w=300 h=300 yaw=80 pitch=39( |$)/)
    expect(raw.split('\n').find((l) => l.includes('Art/fixed.glb'))).not.toMatch(/yaw=/)
    const read = parseBoard(raw).doc.items.find((it) => it.kind === 'picture' && it.path === 'Art/robot.glb') as PictureItem
    expect(read.turn).toEqual({ yaw: 80, pitch: 39 })
    expect(read.turn).toEqual(turnOf(r, id.robot))
  })

  it('goes out to whoever listens to the board as a change, once for the drag’s steps and once at its end', () => {
    const { doc } = board()
    const r = new Rig(doc)
    r.c.exec('tool.turn')
    r.forget()
    r.drag(at(0, 0), at(80, 0), {}, 8)
    expect(r.changes.length).toBeGreaterThan(1)
    expect(r.changes.every((c) => c.why.reason === 'turn')).toBe(true)
    // Every step of the drag is a change for the savers to hear (not final), and only the end is.
    expect(r.changes.filter((c) => c.why.final)).toHaveLength(1)
    expect(r.changes.at(-1)!.why.final).toBe(true)
  })
})
