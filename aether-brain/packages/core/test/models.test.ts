import { describe, expect, it } from 'vitest'
import {
  AssetResolver,
  MODEL_EXTENSIONS,
  MemoryVaultAdapter,
  PLANET_MIN_BYTES,
  SearchIndex,
  applyChanges,
  assetMap,
  buildGraph,
  folderKey,
  imageBaseName,
  imageKey,
  isAssetPath,
  isImagePath,
  isMediaPath,
  isModelPath,
  isPlanetNode,
  isVideoPath,
  isVirtualId,
  parseNote,
  type NoteId,
  type ParsedNote,
  type VaultAsset,
} from '../src'

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

describe('3D models in the vault', () => {
  it('a .glb is a model, in any letter case, and only .glb', () => {
    expect([...MODEL_EXTENSIONS]).toEqual(['glb'])
    for (const p of ['robot.glb', 'Art/Robot.GLB', 'a/b/c.Glb']) expect(isModelPath(p)).toBe(true)
    // The text form of glTF points at other files: not one self-contained model, so not shown.
    for (const p of ['scene.gltf', 'robot.glb.png', 'robot.glbx', 'glb', 'robot.fbx', 'robot.obj', 'note.md']) expect(isModelPath(p)).toBe(false)
  })

  it('a model is not media: reference boards (isMediaPath) and writes (isImagePath) never take one', () => {
    expect(isMediaPath('robot.glb')).toBe(false)
    expect(isImagePath('robot.glb')).toBe(false)
    expect(isVideoPath('robot.glb')).toBe(false)
    // …and what they took before they still take.
    for (const p of ['a.png', 'a.JPG', 'a.webp', 'a.gif', 'a.bmp', 'a.avif', 'a.mp4', 'a.m4v', 'a.mov', 'a.webm']) {
      expect(isMediaPath(p)).toBe(true)
      expect(isAssetPath(p)).toBe(true)
    }
  })

  it('the vault lists a model beside pictures and videos, and nothing else', () => {
    expect(isAssetPath('Art/robot.glb')).toBe(true)
    for (const p of ['note.md', 'scene.gltf', 'scene.bin', 'tool.exe', 'icon.svg', 'a.png.txt']) expect(isAssetPath(p)).toBe(false)
    const map = assetMap([
      { path: 'Art/robot.glb', mtime: 5, size: 200_000 },
      { path: 'Art/gate.png', mtime: 4 },
      { path: 'Art/scene.gltf', mtime: 3 },
      { path: 'node_modules/pkg/ship.glb', mtime: 2 },
      { path: '.git/objects/x.glb', mtime: 1 },
    ])
    expect([...map.keys()].sort()).toEqual(['Art/gate.png', 'Art/robot.glb'])
    expect(map.get('Art/robot.glb')).toEqual({ path: 'Art/robot.glb', mtime: 5, size: 200_000 })
  })

  it('a link to a model resolves like a link to a picture: exact path, relative, then the name anywhere', () => {
    const r = new AssetResolver(['Art/robot.glb', 'Ships/hull.glb', 'Refs/hull.glb', 'Art/gate.png'])
    expect(r.resolve('Art/robot.glb')).toBe('Art/robot.glb')
    expect(r.resolve('robot.GLB')).toBe('Art/robot.glb')
    expect(r.resolve('./robot.glb', 'Art')).toBe('Art/robot.glb')
    // Two models of one name: the one nearest the note wins, as for pictures.
    expect(r.resolve('hull.glb', 'Ships')).toBe('Ships/hull.glb')
    expect(r.resolve('hull.glb', 'Refs')).toBe('Refs/hull.glb')
    expect(r.resolve('missing.glb')).toBeNull()
    expect(imageBaseName('Art/robot.glb')).toBe('robot')
  })

  it('an embedded model is an image node flagged as a model, linked from its note and never a ghost', () => {
    const files = {
      'Projects/Game.md': '---\ntype: project\n---\n# Game\n\nThe hero: ![[hero.glb]]\n\nAnd a picture ![[gate.png]]. Missing: ![[nope.glb]]\n',
    }
    const notes = notesOf(files)
    const g = buildGraph(notes, {
      images: {
        all: assetMap([
          { path: 'Projects/Game/Art/hero.glb', mtime: 9, size: 5_000_000 },
          { path: 'Projects/Game/Art/gate.png', mtime: 8, size: 90_000 },
        ]),
      },
    })
    const hero = g.nodes[g.index.get(imageKey('Projects/Game/Art/hero.glb'))!]!
    expect(hero.kind).toBe('image')
    expect(hero.title).toBe('hero.glb')
    expect(hero.image).toMatchObject({ path: 'Projects/Game/Art/hero.glb', size: 5_000_000, model: true })
    expect(hero.image?.video).toBeUndefined()
    expect(isVirtualId(hero.id)).toBe(true)
    // A picture carries neither flag.
    const gate = g.nodes[g.index.get(imageKey('Projects/Game/Art/gate.png'))!]!
    expect(gate.image?.model).toBeUndefined()
    // The link is resolved, and a missing model makes no ghost note (like a missing picture).
    expect(g.edges.some((e) => e.from === 'Projects/Game' && e.to === hero.id)).toBe(true)
    expect(g.nodes.filter((n) => n.ghost)).toHaveLength(0)
    // The note's own links say so too: the model's resolved, the missing one is left unresolved (no node, no ghost).
    const links = notes.get('Projects/Game')!.links
    expect(links.find((l) => l.raw === 'hero.glb')).toMatchObject({ resolved: true, to: hero.id })
    expect(links.find((l) => l.raw === 'nope.glb')).toMatchObject({ resolved: false })
  })

  it('a model is a planet when it is big enough to matter or nobody has sized it, a moon when it is tiny', () => {
    const files = { 'Art/Note.md': '# Note\n\n![[big.glb]] ![[tiny.glb]] ![[unsized.glb]]\n' }
    const g = buildGraph(notesOf(files), {
      images: {
        all: assetMap([
          { path: 'Art/big.glb', mtime: 1, size: PLANET_MIN_BYTES },
          { path: 'Art/tiny.glb', mtime: 1, size: PLANET_MIN_BYTES - 1 },
          { path: 'Art/unsized.glb', mtime: 1 },
        ]),
      },
    })
    const body = (name: string) => isPlanetNode(g.nodes[g.index.get(imageKey(`Art/${name}`))!]!) ? 'planet' : 'moon'
    expect(body('big.glb')).toBe('planet')
    expect(body('tiny.glb')).toBe('moon')
    expect(body('unsized.glb')).toBe('planet')
  })

  it('a folder shows its newest models as moons of its star, together with its pictures', () => {
    const g = buildGraph(notesOf({ 'Art/Note.md': '# Note\n' }), {
      images: {
        all: assetMap([
          { path: 'Art/old.png', mtime: 1, size: 100_000 },
          { path: 'Art/robot.glb', mtime: 5, size: 100_000 },
        ]),
        moons: true,
      },
      folders: { all: new Set(['Art']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    const art = g.nodes[g.index.get(folderKey('Art'))!]!
    expect(art.folder).toMatchObject({ images: 2, shownImages: 2 })
    const robot = g.nodes[g.index.get(imageKey('Art/robot.glb'))!]!
    expect(robot.parent).toBe(folderKey('Art'))
    expect(robot.image?.model).toBe(true)
  })

  it('changes of a model file are tracked like a picture’s, copy on write', () => {
    const search = new SearchIndex()
    const base = new Map<string, VaultAsset>([['A/x.png', { path: 'A/x.png', mtime: 1 }]])
    const added = applyChanges(new Map(), [{ kind: 'add', path: 'B/robot.glb', mtime: 2, size: 4096 }], search, { assets: base })
    expect(added.assets).not.toBe(base)
    expect(added.assets.get('B/robot.glb')).toEqual({ path: 'B/robot.glb', mtime: 2, size: 4096 })
    expect(base.has('B/robot.glb')).toBe(false)
    const gone = applyChanges(new Map(), [{ kind: 'unlink', path: 'B/robot.glb' }], search, { assets: added.assets })
    expect(gone.assets.has('B/robot.glb')).toBe(false)
    // A file that is no asset of the vault is still left alone (not a note either).
    const same = applyChanges(new Map(), [{ kind: 'add', path: 'B/scene.gltf', mtime: 3, size: 10 }], search, { assets: added.assets })
    expect(same.assets.has('B/scene.gltf')).toBe(false)
  })

  it('the memory adapter lists a model and has no still for it (only the desktop helper draws one)', async () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])
    const a = new MemoryVaultAdapter([{ path: 'Art/note.md', content: '# n' }], { assets: [{ path: 'Art/robot.glb', data: glb, mtime: 7 }] })
    expect(await a.listAssets()).toEqual([{ path: 'Art/robot.glb', mtime: 7, size: glb.byteLength }])
    expect(await a.thumbnail('Art/robot.glb', 128)).toBeNull()
  })
})
