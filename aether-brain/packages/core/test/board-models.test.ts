import { describe, expect, it } from 'vitest'
import { parseNote } from '../src/markdown/parse'
import { parseBoard, serializeBoard } from '../src/board/format'
import { setProps } from '../src/board/ops'
import { emptyBoard } from '../src/board/types'
import type { BoardDoc, PictureItem } from '../src/board/types'
import { isBoardAssetPath, isMediaPath, isModelPath } from '../src/vault/assets'
import { MODEL_VIEW_DEFAULT, isDefaultView, normaliseView } from '../src/models/proxyRaster'
import { assetMap, buildGraph, type NoteId, type ParsedNote } from '../src'

/**
 * A reference board holds a 3D model too (a `.glb`): a picture line like any other, with the view the user turned it to (`yaw=`,
 * `pitch=`) as two more attributes. The model is drawn from its proxy and never as a file; this is the data side: what a board may
 * hold, what is kept in the note, and the operation that turns it.
 */

const NOW = new Date(2026, 9, 23, 20, 0, 0)

const pic = (over: Partial<PictureItem> = {}): PictureItem => ({
  id: 1,
  group: 0,
  locked: false,
  kind: 'picture',
  path: 'Art/robot.glb',
  x: 0,
  y: 0,
  w: 256,
  h: 256,
  rotation: 0,
  crop: { l: 0, t: 0, r: 1, b: 1 },
  flipH: false,
  flipV: false,
  gray: false,
  opacity: 1,
  caption: '',
  ...over,
})

const board = (...items: PictureItem[]): BoardDoc => ({ ...emptyBoard('Refs'), items: items.map((it, i) => ({ ...it, id: i + 1 })), nextId: items.length + 1 })
const lines = (doc: BoardDoc): string[] => serializeBoard(doc, undefined, NOW).split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- view'))

describe('what a board may hold', () => {
  it('is a picture, a video or a 3D model, in any letter case, and nothing else', () => {
    for (const p of ['a.png', 'A/B.JPG', 'x.jpeg', 'clip.mp4', 'CLIP.MOV', 'a.webm', 'robot.glb', 'Art/Robot.GLB', 'a/b/c.Glb']) expect(isBoardAssetPath(p), p).toBe(true)
    for (const p of ['note.md', 'scene.gltf', 'robot.glb.png.txt', 'robot.glbx', 'glb', 'a.fbx', 'a.obj', 'a.svg', 'a.ogv', '']) expect(isBoardAssetPath(p), p).toBe(false)
  })

  it('leaves the thumbnails’ own list as it was: a model is still not media', () => {
    expect(isMediaPath('robot.glb')).toBe(false)
    expect(isModelPath('robot.glb')).toBe(true)
    for (const p of ['a.png', 'clip.mp4']) expect(isBoardAssetPath(p)).toBe(isMediaPath(p))
  })
})

describe('a model on a board, in the note', () => {
  it('is a picture line with the path as it is (a model is never embedded: a wikilink to it would be a link to a file the markdown preview cannot show)', () => {
    const [line] = lines(board(pic()))
    expect(line).toBe('- pic Art/robot.glb x=0 y=0 w=256 h=256')
    const read = parseBoard(serializeBoard(board(pic()), undefined, NOW)).doc.items[0] as PictureItem
    expect(read.kind).toBe('picture')
    expect(read.path).toBe('Art/robot.glb')
    expect(read.turn).toBeUndefined()
  })

  it('keeps how it was turned: yaw and pitch after the crop and before grey and opacity, one decimal each', () => {
    const [line] = lines(board(pic({ turn: { yaw: 120.46, pitch: -10.04 }, gray: true, opacity: 0.5, crop: { l: 0.1, t: 0, r: 1, b: 1 }, flipH: true, rotation: 30 })))
    // (The file writes numbers below one without the leading zero, as it always has: `crop=.1`, `op=.5`.)
    expect(line).toBe('- pic Art/robot.glb x=0 y=0 w=256 h=256 r=30 flip=h crop=.1,0,1,1 yaw=120.5 pitch=-10 gray op=.5')
    const read = parseBoard(`## Board\n\n${line}\n`).doc.items[0] as PictureItem
    expect(read.turn).toEqual({ yaw: 120.5, pitch: -10 })
  })

  it('writes no view for the first view, so a model nobody turned has no extra words, and a turn back to it takes them away again', () => {
    expect(lines(board(pic({ turn: { ...MODEL_VIEW_DEFAULT } })))[0]).toBe('- pic Art/robot.glb x=0 y=0 w=256 h=256')
    expect(lines(board(pic({ turn: { yaw: 35.04, pitch: 23.96 } })))[0]).toBe('- pic Art/robot.glb x=0 y=0 w=256 h=256')
    const read = parseBoard('## Board\n\n- pic Art/robot.glb x=0 y=0 w=256 h=256 yaw=35 pitch=24\n').doc.items[0] as PictureItem
    expect('turn' in read).toBe(false)
  })

  it('reads each of the two alone, with the first view for the other', () => {
    const a = parseBoard('## Board\n\n- pic Art/robot.glb x=0 y=0 w=256 h=256 yaw=90\n').doc.items[0] as PictureItem
    expect(a.turn).toEqual({ yaw: 90, pitch: MODEL_VIEW_DEFAULT.pitch })
    const b = parseBoard('## Board\n\n- pic Art/robot.glb x=0 y=0 w=256 h=256 pitch=-45\n').doc.items[0] as PictureItem
    expect(b.turn).toEqual({ yaw: MODEL_VIEW_DEFAULT.yaw, pitch: -45 })
    // And a file written by one of them is written back with both.
    expect(lines({ ...board(pic()), items: [{ ...a, id: 1 }] })[0]).toContain('yaw=90 pitch=24')
  })

  it('brings a view that is out of range in, and says so, and never fails for a value that is not a number', () => {
    const read = (attrs: string) => parseBoard(`## Board\n\n- pic Art/robot.glb x=0 y=0 w=256 h=256 ${attrs}\n`)
    const wrap = read('yaw=360')
    expect(wrap.doc.items[0]).toMatchObject({ turn: { yaw: 0, pitch: 24 } })
    const high = read('yaw=40 pitch=200')
    expect((high.doc.items[0] as PictureItem).turn).toEqual({ yaw: 40, pitch: 89 })
    expect(high.warnings.join(' ')).toMatch(/pitch=200 is outside -89 to 89, 89 used/)
    const low = read('yaw=40 pitch=-200')
    expect((low.doc.items[0] as PictureItem).turn).toEqual({ yaw: 40, pitch: -89 })
    const junk = read('yaw=left pitch=up')
    expect('turn' in (junk.doc.items[0] as PictureItem)).toBe(false)
    expect(junk.warnings.join(' ')).toMatch(/yaw="left" is not a number/)
    expect(read('yaw=-90').doc.items[0]).toMatchObject({ turn: { yaw: 0, pitch: 24 } })
  })

  it('leaves yaw and pitch alone on anything that is not a model: they are attributes this version does not know there, kept as written', () => {
    const raw = '## Board\n\n- ![[Art/gate.png]] x=0 y=0 w=256 h=256 yaw=90 pitch=10 pinned\n'
    const read = parseBoard(raw)
    const item = read.doc.items[0] as PictureItem
    expect('turn' in item).toBe(false)
    expect(item.unknown).toEqual(['yaw=90', 'pitch=10', 'pinned'])
    expect(lines(read.doc)[0]).toBe('- ![[Art/gate.png]] x=0 y=0 w=256 h=256 yaw=90 pitch=10 pinned')
    // A view on an item that is not a model is not written even if one got there.
    expect(lines(board(pic({ path: 'Art/gate.png', turn: { yaw: 90, pitch: 10 } })))[0]).toBe('- ![[Art/gate.png]] x=0 y=0 w=256 h=256')
  })

  it('round-trips every view the user can turn to: what is in memory is what is in the file (a thousand of them)', () => {
    let seed = 7
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 1000; i++) {
      const turn = normaliseView({ yaw: next() * 720 - 180, pitch: next() * 200 - 100 })
      const doc = board(pic({ turn }))
      const read = parseBoard(serializeBoard(doc, undefined, NOW)).doc.items[0] as PictureItem
      if (isDefaultView(turn)) expect(read.turn).toBeUndefined()
      else expect(read.turn, JSON.stringify(turn)).toEqual(turn)
    }
  })

  it('is a link of the board to the model, as a picture is: the brain draws the model round the board’s sun', () => {
    const raw = serializeBoard(board(pic(), pic({ path: 'Art/gate.png', turn: undefined })), undefined, NOW)
    const n = parseNote({ path: 'Boards/Refs.md', content: raw })
    expect(n.links.map((l) => l.to)).toEqual(['Art/robot.glb', 'Art/gate.png'])
    expect(n.links.every((l) => l.kind === 'embed')).toBe(true)
    // And a model line is one of the board's own: it counts toward the board's items and is not mistaken for a user's bullet.
    expect(parseBoard(raw).doc.items).toHaveLength(2)
    const loose = parseBoard('## Board\n\n- view smooth\n\n- pic Art/robot.glb x=0 y=0 w=256 h=256 yaw=10\n')
    expect(loose.doc.items).toHaveLength(1)
  })

  it('makes a model of the vault orbit a board that holds it, like a picture does (the board is a sun)', () => {
    const raw = ['---', 'title: Refs', 'type: board', '---', '# Refs', '', '## Board', '', '- pic Art/robot.glb x=0 y=0 w=256 h=256 yaw=90 pitch=10', '- pic Art/gate.png x=300 y=0 w=100 h=100', ''].join('\n')
    const notes = new Map<NoteId, ParsedNote>()
    const n = parseNote({ path: 'Boards/Refs.md', content: raw })
    notes.set(n.meta.id, n)
    const g = buildGraph(notes, {
      images: { all: assetMap([{ path: 'Art/robot.glb', mtime: 1, size: 5_000_000 }, { path: 'Art/gate.png', mtime: 1, size: 200_000 }]), moons: true, maxPerFolder: 24 },
      folders: { all: new Set(['Art', 'Boards']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    const sun = g.nodes[g.index.get('Boards/Refs')!]!
    expect(sun.board).toEqual({ pictures: 2 })
    const model = g.nodes[g.index.get('image:Art/robot.glb')!]!
    expect(model.image?.model).toBe(true)
    expect(model.parent).toBe('Boards/Refs')
    expect(g.nodes[g.index.get('image:Art/gate.png')!]!.parent).toBe('Boards/Refs')
  })
})

describe('turning a model', () => {
  const doc = board(pic(), pic({ path: 'Art/gate.png' }), pic({ locked: true, path: 'Art/other.glb' }))

  it('sets the view of the models selected, brought into range and to one decimal, and changes nothing else', () => {
    const next = setProps(doc, [1], { turn: { yaw: 400.04, pitch: 95 } })
    expect((next.items[0] as PictureItem).turn).toEqual({ yaw: 40, pitch: 89 })
    expect(next.items[0]).toMatchObject({ x: 0, y: 0, w: 256, rotation: 0 })
    expect(next.items[1]).toBe(doc.items[1])
    expect(next.items[2]).toBe(doc.items[2])
  })

  it('does nothing to a picture that is not a model, and nothing to a locked one', () => {
    expect(setProps(doc, [2], { turn: { yaw: 90, pitch: 0 } })).toBe(doc)
    expect(setProps(doc, [3], { turn: { yaw: 90, pitch: 0 } })).toBe(doc)
  })

  it('puts a model back to its first view with null, or with the first view itself, and a turn to where it already is is no change at all', () => {
    const turned = setProps(doc, [1], { turn: { yaw: 200, pitch: 5 } })
    expect((setProps(turned, [1], { turn: null }).items[0] as PictureItem).turn).toBeUndefined()
    expect('turn' in setProps(turned, [1], { turn: null }).items[0]!).toBe(false)
    expect('turn' in setProps(turned, [1], { turn: { ...MODEL_VIEW_DEFAULT } }).items[0]!).toBe(false)
    expect(setProps(turned, [1], { turn: { yaw: 200.01, pitch: 5 } })).toBe(turned)
    expect(setProps(doc, [1], { turn: null })).toBe(doc)
    expect(setProps(doc, [1], { turn: { ...MODEL_VIEW_DEFAULT } })).toBe(doc)
  })

  it('takes no view that is not numbers, and keeps the one the model has', () => {
    const turned = setProps(doc, [1], { turn: { yaw: 200, pitch: 5 } })
    for (const bad of [{ yaw: NaN, pitch: 5 }, { yaw: 1, pitch: Infinity }, { yaw: '9', pitch: 5 }, {}] as unknown as { yaw: number; pitch: number }[]) expect(setProps(turned, [1], { turn: bad })).toBe(turned)
  })

  it('goes through the history of the board like any other change: one step back', () => {
    const turned = setProps(doc, [1], { turn: { yaw: 90, pitch: 10 } })
    expect(turned).not.toBe(doc)
    expect(turned.items[0]).not.toBe(doc.items[0])
    expect(doc.items[0]).not.toHaveProperty('turn')
  })
})
