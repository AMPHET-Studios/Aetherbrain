import { describe, expect, it } from 'vitest'
import {
  SUN_LEVELS,
  SUN_LEVEL_NAMES,
  bodyOrder,
  bodyOwners,
  bodyTiers,
  buildGraph,
  folderKey,
  isSunNode,
  parseNote,
  sunCounts,
  type GraphData,
  type GraphNode,
  type NoteId,
  type ParsedNote,
} from '../src'

/**
 * Suns open into planets, then moons (docs/COSMOLOGY.md): which sun each body belongs to, what a sun must show for the body to show
 * (its tier), what each sun holds (its counts, behind the sun bar's buttons) and the order that lets one pass settle who is shown.
 */

const LONG = `${'word '.repeat(3100)}\n`

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

const FILES: Record<string, string> = {
  'Home.md': '# Home\n',
  'Projects/Alpha/Plan.md': '# Plan\n',
  'Projects/Alpha/Big.md': `# Big\n\n${LONG}`,
  'Projects/Alpha/Sub/Deep.md': '# Deep\n',
  'Work/Todo.md': '# Todo\n\nSee [[Nowhere]].\n',
}
const FOLDERS = ['Projects', 'Projects/Alpha', 'Projects/Alpha/Sub', 'Work', 'Empty']

function build(files = FILES): GraphData {
  return buildGraph(notesOf(files), { folders: { all: new Set(FOLDERS), rootTitle: 'Vault', multiRoot: false, maxDepth: 5 } })
}

const idx = (g: GraphData, id: string): number => {
  const i = g.index.get(id)
  if (i === undefined) throw new Error(`no node ${id}`)
  return i
}
const node = (g: GraphData, id: string): GraphNode => g.nodes[idx(g, id)]!

describe('the levels', () => {
  it('are closed, planets, and planets with moons, in that order', () => {
    expect(SUN_LEVELS).toEqual([0, 1, 2])
    expect(SUN_LEVEL_NAMES).toEqual({ 0: 'Closed', 1: 'Planets', 2: 'Planets + moons' })
  })
})

describe('which bodies are suns', () => {
  const g = build()

  it('are the folders (galaxy and stars), and a reference board with pictures on it', () => {
    expect(isSunNode(node(g, folderKey('')))).toBe(true)
    expect(isSunNode(node(g, folderKey('Projects/Alpha')))).toBe(true)
    expect(isSunNode(node(g, 'Home'))).toBe(false)
    const board = build()
    node(board, 'Home').board = { pictures: 2 }
    expect(isSunNode(node(board, 'Home'))).toBe(true)
  })

  it('are not the Bio star before its folder exists: it has nothing in it to open', () => {
    const star = node(g, folderKey('Empty'))
    expect(isSunNode(star)).toBe(true)
    star.folder = { ...star.folder!, bio: true, placeholder: true }
    expect(isSunNode(star)).toBe(false)
  })
})

describe('the tier of a body: what its sun must show for it to show', () => {
  const g = build()
  const tiers = bodyTiers(g)
  const tier = (id: string): number => tiers[idx(g, id)]!

  it('is 0 for the galaxy and for the folders directly under it: a closed vault is a field of suns, not one point', () => {
    expect(tier(folderKey(''))).toBe(0)
    expect(tier(folderKey('Projects'))).toBe(0)
    expect(tier(folderKey('Work'))).toBe(0)
  })

  it('is 1 for the sun of a deeper folder: it comes out with the planets', () => {
    expect(tier(folderKey('Projects/Alpha'))).toBe(1)
    expect(tier(folderKey('Projects/Alpha/Sub'))).toBe(1)
  })

  it('is 1 for a long note (a planet) and 2 for a small one (a moon) and for an unresolved link', () => {
    expect(tier('Projects/Alpha/Big')).toBe(1)
    expect(tier('Projects/Alpha/Plan')).toBe(2)
    expect(tier('Home')).toBe(2)
    expect(tier('ghost:Nowhere')).toBe(2)
  })

  it('is 1 for a reference board with pictures (a sun that comes out with the planets) and 0 for the Today hub', () => {
    const board = build()
    node(board, 'Home').board = { pictures: 1 }
    expect(bodyTiers(board)[idx(board, 'Home')]).toBe(1)
    const hub = build()
    hub.nodes.push({ ...node(hub, 'Home'), id: 'today:', kind: 'today', title: 'Today', parent: null })
    hub.index.set('today:', hub.nodes.length - 1)
    expect(bodyTiers(hub)[hub.nodes.length - 1]).toBe(0)
  })

  it('is 0 for a folder whose parent is not in the graph (nothing above it to hold it back)', () => {
    const lone = build()
    node(lone, folderKey('Work')).parent = 'folder:Gone'
    expect(bodyTiers(lone)[idx(lone, folderKey('Work'))]).toBe(0)
  })
})

describe('the sun a body belongs to', () => {
  const g = build()
  const owners = bodyOwners(g)
  const ownerOf = (id: string): string | null => {
    const o = owners[idx(g, id)]!
    return o < 0 ? null : g.nodes[o]!.id
  }

  it('is its folder for a note, and its parent folder for a folder', () => {
    expect(ownerOf('Projects/Alpha/Plan')).toBe(folderKey('Projects/Alpha'))
    expect(ownerOf('Projects/Alpha/Sub/Deep')).toBe(folderKey('Projects/Alpha/Sub'))
    expect(ownerOf(folderKey('Projects/Alpha/Sub'))).toBe(folderKey('Projects/Alpha'))
    expect(ownerOf(folderKey('Projects/Alpha'))).toBe(folderKey('Projects'))
    expect(ownerOf('Home')).toBe(folderKey(''))
  })

  it('is the folder of the note that links to it, for an unresolved link', () => {
    expect(ownerOf('ghost:Nowhere')).toBe(folderKey('Work'))
  })

  it('is nothing for the galaxy itself, and nothing for a drive of a vault with several roots: a drive is a galaxy too', () => {
    expect(ownerOf(folderKey(''))).toBeNull()
    const drives = buildGraph(notesOf({ 'D/Work/Plan.md': '# Plan\n', 'F/Art/Study.md': '# Study\n' }), {
      folders: { all: new Set(['D', 'D/Work', 'F', 'F/Art']), rootTitle: 'Drives', multiRoot: true, maxDepth: 3 },
    })
    const o = bodyOwners(drives)
    expect(o[idx(drives, folderKey('D'))]).toBe(-1)
    expect(o[idx(drives, folderKey('F'))]).toBe(-1)
    // What is on a drive belongs to the drive.
    expect(o[idx(drives, folderKey('D/Work'))]).toBe(idx(drives, folderKey('D')))
  })

  it('is the board a picture orbits, found by walking up past bodies that are not suns', () => {
    const b = build()
    node(b, 'Home').board = { pictures: 1 }
    node(b, 'Projects/Alpha/Plan').parent = 'Home'
    const o = bodyOwners(b)
    expect(o[idx(b, 'Projects/Alpha/Plan')]).toBe(idx(b, 'Home'))
  })

  it('is nothing for a body in a graph built without folders', () => {
    const flat = buildGraph(notesOf({ 'A.md': '# A\n', 'B.md': '# B\n' }))
    expect([...bodyOwners(flat)]).toEqual([-1, -1])
  })

  it('skips the Bio star before its folder exists as a sun: its own sun is the galaxy, and nothing orbits it', () => {
    const b = build()
    const star = node(b, folderKey('Empty'))
    star.folder = { ...star.folder!, bio: true, placeholder: true }
    expect(bodyOwners(b)[idx(b, folderKey('Empty'))]).toBe(idx(b, folderKey('')))
  })
})

describe('the order that lets one pass settle who is shown', () => {
  it('lists every sun before every body it owns, and every node once', () => {
    const g = build()
    const owners = bodyOwners(g)
    const order = bodyOrder(owners)
    expect(order).toHaveLength(g.nodes.length)
    expect(new Set(order).size).toBe(g.nodes.length)
    const at = new Map<number, number>()
    order.forEach((node, position) => at.set(node, position))
    for (let i = 0; i < owners.length; i++) {
      const o = owners[i]!
      if (o >= 0) expect(at.get(o)!, `${g.nodes[o]!.id} before ${g.nodes[i]!.id}`).toBeLessThan(at.get(i)!)
    }
  })

  it('puts a chain right whatever order the nodes are listed in', () => {
    // 0 is owned by 1, 1 by 2, 2 by 3, 3 by nobody.
    const order = [...bodyOrder(Int32Array.from([1, 2, 3, -1]))]
    expect(order).toEqual([3, 2, 1, 0])
  })

  it('keeps the listing order within a level (stable), so the same graph gives the same order', () => {
    expect([...bodyOrder(Int32Array.from([-1, 0, 0, 0]))]).toEqual([0, 1, 2, 3])
    expect([...bodyOrder(Int32Array.from([-1, -1, 0, 1]))]).toEqual([0, 1, 2, 3])
  })

  it('cannot be hung by an owner cycle, which a sane graph never has', () => {
    const order = [...bodyOrder(Int32Array.from([1, 0, 1]))]
    expect(order.slice().sort()).toEqual([0, 1, 2])
  })

  it('handles an empty graph', () => {
    expect(bodyOrder(new Int32Array(0))).toHaveLength(0)
  })
})

describe('what a sun holds', () => {
  const g = build()
  const counts = sunCounts(g)

  it('counts planets, sub-folder suns and moons apart (the sun bar’s buttons are enabled by them)', () => {
    expect(counts.get(folderKey('Projects/Alpha'))).toEqual({ planets: 1, systems: 1, moons: 1 })
    expect(counts.get(folderKey('Projects/Alpha/Sub'))).toEqual({ planets: 0, systems: 0, moons: 1 })
  })

  it('counts an unresolved link as a moon of the sun above the note that links to it', () => {
    expect(counts.get(folderKey('Work'))).toEqual({ planets: 0, systems: 0, moons: 2 })
  })

  it('leaves out what is always shown: the folders directly under the galaxy are not the galaxy’s to hold back', () => {
    // The vault's own notes are its moons; Projects and Work are always out, so they are not counted.
    expect(counts.get(folderKey(''))).toEqual({ planets: 0, systems: 0, moons: 1 })
    expect(counts.get(folderKey('Projects'))).toEqual({ planets: 0, systems: 1, moons: 0 })
  })

  it('has no entry for a sun with nothing in it, nor for one that holds only what is always shown', () => {
    expect(counts.has(folderKey('Empty'))).toBe(false)
    // The vault with only folders and one note in each: the galaxy holds the folders under it, which are always out, so nothing.
    const only = build({ 'Work/Todo.md': '# Todo\n', 'Projects/Alpha/Plan.md': '# Plan\n' })
    expect(sunCounts(only).has(folderKey(''))).toBe(false)
    expect(sunCounts(only).has(folderKey('Empty'))).toBe(false)
    expect(sunCounts(only).get(folderKey('Work'))).toEqual({ planets: 0, systems: 0, moons: 1 })
  })

  it('does not count the Today hub as anyone’s body', () => {
    const hub = build()
    hub.nodes.push({ ...node(hub, 'Home'), id: 'today:', kind: 'today', title: 'Today', parent: folderKey('') })
    hub.index.set('today:', hub.nodes.length - 1)
    expect(sunCounts(hub).get(folderKey(''))).toEqual({ planets: 0, systems: 0, moons: 1 })
  })

  it('counts a picture as a planet when it is big (or nobody has sized it) and as a moon when it is small', () => {
    const p = build()
    const pic = (id: string, size: number | null): GraphNode => ({
      ...node(p, 'Home'),
      id,
      kind: 'image',
      title: id,
      parent: folderKey('Work'),
      image: { path: id.slice(6), size, mtime: 1, width: 10, height: 10, video: false, model: false } as unknown as GraphNode['image'],
    })
    for (const [i, size] of [100_000, 1_000, null].entries()) {
      p.nodes.push(pic(`image:Work/p${i}.png`, size))
      p.index.set(`image:Work/p${i}.png`, p.nodes.length - 1)
    }
    // A big one, one nobody sized: planets. A small one: a moon (on top of the two it had).
    expect(sunCounts(p).get(folderKey('Work'))).toEqual({ planets: 2, systems: 0, moons: 3 })
  })
})
