import { describe, expect, it } from 'vitest'
import {
  PLANET_MIN_BYTES,
  PLANET_MIN_WORDS,
  assetMap,
  buildGraph,
  daysBetween,
  imageKey,
  isGalaxyNode,
  isPlanetNode,
  noteUrgency,
  parseNote,
  systemUrgency,
  taskUrgency,
  tasksOf,
  type GraphNode,
  type NoteId,
  type ParsedNote,
} from '../src'

const DATE = '2026-09-30'

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

/** Urgency of the one open task in `line`. */
function taskU(line: string, daily = false): number {
  const note = parseNote({ path: 'Work/T.md', content: `# T\n\n${line}\n` })
  return taskUrgency(tasksOf(note)[0]!, DATE, daily)
}

describe('urgency of a task', () => {
  it('counts days between dates', () => {
    expect(daysBetween('2026-09-30', '2026-10-01')).toBe(1)
    expect(daysBetween('2026-09-30', '2026-09-27')).toBe(-3)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('nonsense', '2026-01-01')).toBe(0)
  })

  it('rises as the date comes: later, a week, three days, tomorrow, today, overdue', () => {
    const later = taskU('- [ ] x 📅 2026-12-01')
    const fortnight = taskU('- [ ] x 📅 2026-10-12')
    const week = taskU('- [ ] x 📅 2026-10-06')
    const three = taskU('- [ ] x 📅 2026-10-03')
    const tomorrow = taskU('- [ ] x 📅 2026-10-01')
    const today = taskU('- [ ] x 📅 2026-09-30')
    const late = taskU('- [ ] x 📅 2026-09-29')
    expect([later, fortnight, week, three, tomorrow, today, late]).toEqual([0.1, 0.22, 0.38, 0.55, 0.7, 0.85, 0.925])
    expect(taskU('- [ ] x 📅 2026-08-01')).toBe(1)
  })

  it('has a floor for an open task with no date, and nothing for a done one', () => {
    expect(taskU('- [ ] someday')).toBe(0.06)
    expect(taskU('- [x] finished 📅 2026-09-01')).toBe(0)
  })

  it('counts scheduled, #today and the daily note', () => {
    expect(taskU('- [ ] x ⏳ 2026-09-30')).toBe(0.6)
    expect(taskU('- [ ] x #today')).toBe(0.7)
    expect(taskU('- [ ] x', true)).toBe(0.6)
  })
})

describe('urgency of a note and of a system', () => {
  it('is its most urgent task, a little more for other hot ones, nothing in the archive', () => {
    const one = parseNote({ path: 'Work/A.md', content: '# A\n\n- [ ] a 📅 2026-09-30\n' })
    const three = parseNote({ path: 'Work/B.md', content: '# B\n\n- [ ] a 📅 2026-09-30\n- [ ] b 📅 2026-10-01\n- [ ] c 📅 2026-10-02\n' })
    const none = parseNote({ path: 'Work/C.md', content: '# C\n\nNo tasks.\n' })
    const archived = parseNote({ path: 'Archive/D.md', content: '---\narea: archive\n---\n# D\n\n- [ ] a 📅 2026-09-01\n' })
    expect(noteUrgency(one, DATE)).toBe(0.85)
    expect(noteUrgency(three, DATE)).toBeCloseTo(0.89, 6)
    expect(noteUrgency(none, DATE)).toBe(0)
    expect(noteUrgency(archived, DATE)).toBe(0)
  })

  it('makes a system as hot as its hottest member, saturating, so a pile of calm tasks does not outshine one fire', () => {
    expect(systemUrgency([])).toBe(0)
    expect(systemUrgency([0, 0, 0])).toBe(0)
    expect(systemUrgency([0.9])).toBe(0.9)
    const calmPile = systemUrgency(new Array<number>(300).fill(0.06))
    expect(calmPile).toBeCloseTo(0.06, 6)
    const fire = systemUrgency([0.9, 0.2, 0.2, 0.2])
    expect(fire).toBeGreaterThan(0.9)
    expect(fire).toBeLessThanOrEqual(1)
    // More heat in the others raises it, and it never passes 1.
    expect(systemUrgency([0.5, 0.5, 0.5, 0.5])).toBeGreaterThan(systemUrgency([0.5, 0.2]))
    expect(systemUrgency(new Array<number>(500).fill(1))).toBe(1)
  })
})

describe('urgency in the graph', () => {
  const notes = notesOf({
    'Work/Gate/Plan.md': '# Plan\n\n![[gate.png]]\n\n- [ ] Ship the gate 📅 2026-09-29\n',
    'Work/Gate/Notes.md': '# Notes\n\nNothing open.\n',
    'Home/Idle.md': '# Idle\n\n- [ ] Someday maybe\n',
  })
  const assets = assetMap([
    { path: 'Work/Gate/art/gate.png', size: 400_000 },
    { path: 'Home/cat.png', size: 900 },
  ])
  const g = buildGraph(notes, {
    folders: { all: ['Work', 'Work/Gate', 'Work/Gate/art', 'Home'], multiRoot: false, rootTitle: 'Vault' },
    images: { all: assets, moons: true },
    urgency: { date: DATE },
  })
  const node = (id: string): GraphNode => g.nodes[g.index.get(id)!]!

  it('goes to notes from tasks, to pictures from the notes that embed them, and up through the folders', () => {
    expect(node('Work/Gate/Plan').urgency).toBeGreaterThanOrEqual(0.9)
    expect(node('Work/Gate/Notes').urgency).toBe(0)
    expect(node(imageKey('Work/Gate/art/gate.png')).urgency).toBe(node('Work/Gate/Plan').urgency)
    expect(node('folder:Work/Gate').urgency).toBeGreaterThanOrEqual(0.9)
    expect(node('folder:Work').urgency).toBeGreaterThanOrEqual(node('folder:Work/Gate').urgency!)
    expect(node('folder:').urgency).toBeGreaterThanOrEqual(0.9)
    // An idle folder with one undated task is nearly dark.
    expect(node('folder:Home').urgency).toBeLessThan(0.1)
  })

  it('is absent when the graph is built without it', () => {
    const plain = buildGraph(notes, { folders: { all: ['Work', 'Work/Gate', 'Home'], multiRoot: false, rootTitle: 'Vault' } })
    for (const n of plain.nodes) expect(n.urgency).toBeUndefined()
  })
})

describe('what is a planet and what is a moon', () => {
  const g = buildGraph(
    notesOf({
      'Docs/Short.md': '# Short\n\nfew words\n',
      'Docs/Long.md': `# Long\n\n${'word '.repeat(PLANET_MIN_WORDS + 50)}\n`,
    }),
    {
      folders: { all: ['Docs', 'Art'], multiRoot: false, rootTitle: 'Vault' },
      images: {
        all: assetMap([
          { path: 'Art/big.png', size: PLANET_MIN_BYTES },
          { path: 'Art/tiny.png', size: PLANET_MIN_BYTES - 1 },
          { path: 'Art/unknown.png' },
          { path: 'Art/clip.mp4', size: 5_000_000 },
        ]),
        moons: true,
      },
    },
  )
  const node = (id: string): GraphNode => g.nodes[g.index.get(id)!]!

  it('makes visual files of size planets, tiny ones moons, and documents planets', () => {
    expect(isPlanetNode(node(imageKey('Art/big.png')))).toBe(true)
    expect(isPlanetNode(node(imageKey('Art/tiny.png')))).toBe(false)
    // A size nobody looked at is a planet: it is a picture.
    expect(isPlanetNode(node(imageKey('Art/unknown.png')))).toBe(true)
    expect(isPlanetNode(node(imageKey('Art/clip.mp4')))).toBe(true)
    expect(isPlanetNode(node('Docs/Long'))).toBe(true)
    expect(isPlanetNode(node('Docs/Short'))).toBe(false)
  })

  it('never makes a folder or the hub a planet, and flags the galaxies', () => {
    expect(isPlanetNode(node('folder:Docs'))).toBe(false)
    expect(isGalaxyNode(node('folder:'))).toBe(true)
    expect(isGalaxyNode(node('folder:Docs'))).toBe(false)
    const multi = buildGraph(notesOf({ 'D/Docs/A.md': '# A\n', 'F/Art/B.md': '# B\n' }), {
      folders: { all: ['D', 'D/Docs', 'F', 'F/Art'], multiRoot: true, rootTitle: 'D + F' },
    })
    const at = (id: string): GraphNode => multi.nodes[multi.index.get(id)!]!
    expect(isGalaxyNode(at('folder:D'))).toBe(true)
    expect(isGalaxyNode(at('folder:F'))).toBe(true)
    // The origin of several drives is only the origin.
    expect(isGalaxyNode(at('folder:'))).toBe(false)
  })
})
