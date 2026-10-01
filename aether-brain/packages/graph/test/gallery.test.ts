import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetMap, buildGraph, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { BrainController } from '../src/BrainController'
import {
  GALLERY_CLOSE,
  GALLERY_FOLD_MS,
  GALLERY_GROW_MS,
  GALLERY_MIN_EXTENT,
  GALLERY_OPEN,
  GALLERY_REACH_MS,
  GALLERY_SHRINK_MS,
  easeGrow,
  nearestStar,
  stepGrow,
} from '../src/gallery'
import { computeSystemLayout, systemPositions, type SystemInput, type SystemLayout } from '../src/layout/system'
import type { LayoutNodeInput, MainToWorker, WorkerToMain } from '../src/layout/protocol'
import { CARD_FADE_FROM, CARD_FADE_TO, THUMB_SCALE, cardFade, thumbDrawnHalf } from '../src/scene/thumbs'

interface Spec {
  id: string
  parent: string | null
  kind?: 0 | 1 | 2 | 3 | 4
  role?: -1 | 0 | 1 | 2 | 3
  radius?: number
  /** Star gallery card: [anchor id, rank, only]. */
  card?: [string, number, boolean]
}

function input(specs: Spec[], withGallery = true): SystemInput {
  const index = new Map(specs.map((s, i) => [s.id, i]))
  const n = specs.length
  const parent = new Int32Array(n)
  const kind = new Uint8Array(n)
  const role = new Int8Array(n)
  const radius = new Float32Array(n)
  const gallery = new Int32Array(n).fill(-1)
  const galleryRank = new Int32Array(n)
  const galleryOnly = new Uint8Array(n)
  specs.forEach((s, i) => {
    parent[i] = s.parent === null ? -1 : (index.get(s.parent) ?? -1)
    kind[i] = s.kind ?? 0
    role[i] = s.role ?? -1
    radius[i] = s.radius ?? 1
    if (s.card) {
      gallery[i] = index.get(s.card[0]) ?? -1
      galleryRank[i] = s.card[1]
      galleryOnly[i] = s.card[2] ? 1 : 0
    }
  })
  const base = { parent, kind, role, radius, ids: specs.map((s) => s.id) }
  return withGallery ? { ...base, gallery, galleryRank, galleryOnly } : base
}

const folder = (id: string, parent: string | null, radius = 2.5, role: Spec['role'] = parent === null ? 0 : 3): Spec => ({ id, parent, kind: 2, role, radius })
const STAR = 'folder:Projects/PORTALz'

/** Root → Projects → the PORTALz star (a planet with notes and two picture moons) → notes; plus another planet. */
function closedVault(): Spec[] {
  return [
    folder('folder:', null, 8),
    folder('folder:Projects', 'folder:', 4),
    folder(STAR, 'folder:Projects', 5.5, 2),
    folder(`${STAR}/Art`, STAR, 3),
    folder('folder:Areas', 'folder:', 3),
    ...Array.from({ length: 5 }, (_, i): Spec => ({ id: `PORTALz/note ${i}`, parent: STAR, radius: 1.2 })),
    ...Array.from({ length: 4 }, (_, i): Spec => ({ id: `Art/sketch ${i}`, parent: `${STAR}/Art`, radius: 1 })),
    ...Array.from({ length: 6 }, (_, i): Spec => ({ id: `Areas/note ${i}`, parent: 'folder:Areas', radius: 1.3 })),
    { id: 'image:Art/gate.png', parent: `${STAR}/Art`, kind: 4, radius: 1.4 },
    { id: 'image:Art/ruins.png', parent: `${STAR}/Art`, kind: 4, radius: 1.4 },
  ]
}

/** The same vault with the star's gallery open: the two moons are cards, and `extra` more pictures come in. */
function openVault(extra: number): Spec[] {
  const specs = closedVault().map((s): Spec => {
    if (s.id === 'image:Art/gate.png') return { ...s, card: [STAR, 1, false] }
    if (s.id === 'image:Art/ruins.png') return { ...s, card: [STAR, extra + 1, false] }
    return s
  })
  for (let k = 0; k < extra; k++) {
    const rank = k === 0 ? 0 : k + 1
    specs.push({ id: `image:Art/old ${k}.png`, parent: STAR, kind: 4, radius: 1.4, card: [STAR, rank, true] })
  }
  return specs
}

function positionsAt(layout: SystemLayout, t: number): Float32Array {
  const out = new Float32Array(layout.order.length * 3)
  systemPositions(layout, t, out)
  return out
}

const dist = (p: Float32Array, a: number, b: number) => Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!)

describe('star gallery layout', () => {
  const closedSpecs = closedVault()
  const openSpecs = openVault(38)
  const closed = computeSystemLayout(input(closedSpecs))
  const open = computeSystemLayout(input(openSpecs))
  const star = openSpecs.findIndex((s) => s.id === STAR)
  const cards = openSpecs.flatMap((s, i) => (s.card ? [i] : []))

  it('moves nothing else: every other body keeps its orbit, extent and ring', () => {
    expect(cards).toHaveLength(40)
    const n = closedSpecs.length
    expect(Array.from(open.extent.subarray(0, n))).toEqual(Array.from(closed.extent))
    expect(Array.from(open.rings)).toEqual(Array.from(closed.rings))
    for (const t of [0, 3.7, 41]) {
      const a = positionsAt(closed, t)
      const b = positionsAt(open, t)
      for (let i = 0; i < n; i++) {
        if (openSpecs[i]!.card) continue
        expect([b[i * 3], b[i * 3 + 1], b[i * 3 + 2]]).toEqual([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]])
      }
    }
  })

  it('floats the cards on one sphere around the star, clear of its system, never touching', () => {
    const R = open.orbitRadius[cards[0]!]!
    const w = open.card[cards[0]!]! * THUMB_SCALE
    expect(w).toBeGreaterThan(0)
    expect(R - w / 2).toBeGreaterThanOrEqual(open.extent[star]! + 2 - 1e-3)
    for (const t of [0, 12.5]) {
      const p = positionsAt(open, t)
      let closest = Infinity
      for (const a of cards) {
        expect(open.anchor[a]).toBe(star)
        expect(open.card[a]).toBeCloseTo(w / THUMB_SCALE, 5)
        expect(dist(p, a, star)).toBeCloseTo(R, 3)
        for (const b of cards) if (a < b) closest = Math.min(closest, dist(p, a, b))
      }
      expect(closest).toBeGreaterThanOrEqual(w)
    }
    // Only cards have a card size and an anchor.
    open.card.forEach((r, i) => expect(r > 0).toBe(cards.includes(i)))
    open.anchor.forEach((a, i) => expect(a >= 0).toBe(cards.includes(i)))
  })

  it('puts the newest picture at the top, and turns slowly', () => {
    const p = positionsAt(open, 0)
    const top = cards.reduce((best, i) => (p[i * 3 + 1]! > p[best * 3 + 1]! ? i : best), cards[0]!)
    expect(openSpecs[top]!.card![1]).toBe(0)
    const later = positionsAt(open, 10)
    const moved = dist(later, cards[5]!, star) - dist(p, cards[5]!, star)
    expect(Math.abs(moved)).toBeLessThan(1e-3)
    expect(Math.hypot(later[cards[5]! * 3]! - p[cards[5]! * 3]!, later[cards[5]! * 3 + 2]! - p[cards[5]! * 3 + 2]!)).toBeGreaterThan(0.1)
    expect(open.speed[cards[0]!]!).toBeLessThan(0.1)
  })

  it('caps the card size for a few pictures, and keeps a small star’s sphere readable', () => {
    const few = computeSystemLayout(input(openVault(1)))
    const i = openVault(1).findIndex((s) => s.card?.[2])
    const R = few.orbitRadius[i]!
    expect((few.card[i]! * THUMB_SCALE) / R).toBeCloseTo(0.16, 3)
    const tiny = computeSystemLayout(
      input([folder('folder:', null, 8), folder('folder:P', 'folder:', 5.5, 2), { id: 'image:p.png', parent: 'folder:P', kind: 4, radius: 1.4, card: ['folder:P', 0, true] }]),
    )
    expect(tiny.orbitRadius[2]).toBeGreaterThanOrEqual(16)
    expect(tiny.extent[1]).toBeCloseTo(5.5 * 1.6 + 1, 5)
  })

  it('ignores a gallery entry that does not name an ancestor', () => {
    const specs: Spec[] = [
      ...closedVault().filter((s) => !s.id.startsWith('image:')),
      { id: 'image:a.png', parent: 'folder:Areas', kind: 4, radius: 1.4, card: [STAR, 0, true] },
      { id: 'image:b.png', parent: STAR, kind: 4, radius: 1.4, card: ['image:b.png', 0, true] },
    ]
    const layout = computeSystemLayout(input(specs))
    const plain = computeSystemLayout(input(specs, false))
    expect(Array.from(layout.anchor)).toEqual(new Array(specs.length).fill(-1))
    expect(Array.from(layout.card).every((r) => r === 0)).toBe(true)
    expect(Array.from(positionsAt(layout, 2))).toEqual(Array.from(positionsAt(plain, 2)))
  })
})

describe('nearestStar', () => {
  // Two stars: A at the origin (system radius 100), B at x = 300 (system radius 50); a small one at x = 500.
  const pos = new Float32Array([0, 0, 0, 300, 0, 0, 500, 0, 0])
  const extent = new Float32Array([100, 50, 5])
  const stars = [0, 1]

  it('opens within GALLERY_OPEN system radii and holds until GALLERY_CLOSE', () => {
    expect(nearestStar(stars, pos, extent, 0, 0, 200)).toBe(0)
    const between = ((GALLERY_OPEN + GALLERY_CLOSE) / 2) * 100
    expect(nearestStar(stars, pos, extent, 0, 0, between)).toBe(-1)
    expect(nearestStar(stars, pos, extent, 0, 0, between, 0)).toBe(0)
    expect(nearestStar(stars, pos, extent, 0, 0, GALLERY_CLOSE * 100 + 1, 0)).toBe(-1)
  })

  it('hands over to another star only when the camera is clearly closer to it', () => {
    // x = 250: 2.5 radii from A, 1 from B (under 0.6 × 2.5): B takes over.
    expect(nearestStar(stars, pos, extent, 250, 0, 0, 0)).toBe(1)
    // x = 200: 2 radii from each: A stays (and wins the tie without one open).
    expect(nearestStar(stars, pos, extent, 200, 0, 0, 0)).toBe(0)
    expect(nearestStar(stars, pos, extent, 200, 0, 0, -1)).toBe(0)
    expect(nearestStar(stars, pos, extent, 200, 0, 0, 1)).toBe(1)
  })

  it('counts a small system as GALLERY_MIN_EXTENT and skips what it cannot measure', () => {
    expect(nearestStar([2], pos, extent, 500, GALLERY_MIN_EXTENT * 2, 0)).toBe(2)
    expect(nearestStar([0, 7], pos, extent, 0, 0, 100)).toBe(0)
    expect(nearestStar([], pos, extent, 0, 0, 0)).toBe(-1)
    expect(nearestStar([0], pos, new Float32Array([Number.NaN]), 0, 0, 10)).toBe(0)
    // Without a threshold (Shift+G with nothing selected): the closest, however far.
    expect(nearestStar(stars, pos, extent, 0, 0, 5000)).toBe(-1)
    expect(nearestStar(stars, pos, extent, 0, 0, 5000, -1, Infinity)).toBe(0)
  })
})

describe('card growth', () => {
  it('grows over GALLERY_GROW_MS, shrinks faster, never jumps', () => {
    expect(stepGrow(0, false, GALLERY_GROW_MS / 2)).toBeCloseTo(100 / GALLERY_GROW_MS, 5)
    let g = 0
    for (let k = 0; k < 100; k++) g = stepGrow(g, false, 16)
    expect(g).toBe(1)
    let s = 1
    for (let t = 0; t < GALLERY_SHRINK_MS; t += 16) s = stepGrow(s, true, 16)
    expect(s).toBeLessThan(0.05)
    expect(stepGrow(0.5, false, Number.NaN)).toBe(0.5)
    expect(GALLERY_SHRINK_MS).toBeLessThan(GALLERY_FOLD_MS)
    expect([easeGrow(-1), easeGrow(0.5), easeGrow(2)]).toEqual([0, 0.5, 1])
  })
})

describe('cards the camera passes', () => {
  it('stay solid up to CARD_FADE_FROM of the view height and are gone at CARD_FADE_TO', () => {
    expect(cardFade(100, 900)).toBe(1)
    expect(cardFade(CARD_FADE_FROM * 900, 900)).toBe(1)
    const mid = cardFade(((CARD_FADE_FROM + CARD_FADE_TO) / 2) * 900, 900)
    expect(mid).toBeCloseTo(0.5, 5)
    expect(cardFade(CARD_FADE_TO * 900, 900)).toBe(0)
    expect(cardFade(5000, 900)).toBe(0)
    expect([cardFade(Number.NaN, 900), cardFade(300, 0)]).toEqual([1, 1])
  })

  it('are drawn a little bigger close up: labels and picking follow', () => {
    const tan = Math.tan((55 * Math.PI) / 360)
    expect(thumbDrawnHalf(1.2, 4, 900, tan)).toBeCloseTo(1.2, 2)
    // A selected card filling half the view: about a tenth bigger.
    const big = thumbDrawnHalf(1.56, 123, 900, tan)
    expect(big / 1.56).toBeGreaterThan(1.08)
    expect(big / 1.56).toBeLessThan(1.12)
    expect(thumbDrawnHalf(1.2, 1e9, 900, tan)).toBe(1.2 / 0.2)
  })
})

describe('BrainController star galleries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function controller() {
    const c = new BrainController()
    c.layoutMode = 'system'
    const asked: (NoteId | null)[] = []
    c.events = { onGallery: (star) => void asked.push(star) }
    return { c, asked }
  }

  it('opens near a star, folds away from it, and opens again when the camera comes back mid-fold', () => {
    const { c, asked } = controller()
    c.nearStar('folder:A')
    expect(asked).toEqual(['folder:A'])
    c.nearStar(null)
    expect(c.galleryFold).toBeGreaterThanOrEqual(0)
    expect(asked).toEqual(['folder:A'])
    vi.advanceTimersByTime(GALLERY_FOLD_MS)
    expect(asked).toEqual(['folder:A', null])
    expect(c.galleryFold).toBe(-1)
    c.nearStar('folder:A')
    c.nearStar(null)
    vi.advanceTimersByTime(GALLERY_FOLD_MS / 2)
    c.nearStar('folder:A')
    expect(c.galleryFold).toBe(-1)
    vi.advanceTimersByTime(GALLERY_FOLD_MS * 3)
    expect(asked).toEqual(['folder:A', null, 'folder:A'])
    c.nearStar('folder:B')
    expect(asked.at(-1)).toBe('folder:B')
    c.dispose()
  })

  it('Shift+G closes it until the camera leaves the star; opening holds while the camera flies there', () => {
    const { c, asked } = controller()
    c.nearStar('folder:A')
    c.closeGallery()
    vi.advanceTimersByTime(GALLERY_FOLD_MS)
    expect(asked).toEqual(['folder:A', null])
    c.nearStar('folder:A')
    expect(asked).toHaveLength(2)
    c.nearStar(null)
    c.nearStar('folder:A')
    expect(asked).toEqual(['folder:A', null, 'folder:A'])

    // Opened from afar: the fly passes no star (or another one) without closing it…
    c.openGallery('folder:C')
    expect(asked.at(-1)).toBe('folder:C')
    c.nearStar(null)
    c.nearStar('folder:D')
    expect(c.galleryFold).toBe(-1)
    // …reaching it, then leaving it, folds it.
    c.nearStar('folder:C')
    c.nearStar(null)
    vi.advanceTimersByTime(GALLERY_FOLD_MS)
    expect(asked.at(-1)).toBeNull()

    // Never reached: it folds after GALLERY_REACH_MS.
    c.openGallery('folder:E')
    vi.advanceTimersByTime(GALLERY_REACH_MS - 1)
    expect(asked.at(-1)).toBe('folder:E')
    vi.advanceTimersByTime(1 + GALLERY_FOLD_MS)
    expect(asked.at(-1)).toBeNull()
    c.dispose()
  })

  it('auto-open off: only Shift+G opens; leaving the system layout lets go at once', () => {
    const { c, asked } = controller()
    c.galleries = false
    c.nearStar('folder:A')
    expect(asked).toEqual([])
    c.openGallery('folder:A')
    expect(asked).toEqual(['folder:A'])
    c.setLayoutMode('constellation')
    expect(asked).toEqual(['folder:A', null])
    c.galleries = true
    c.nearStar('folder:B')
    expect(asked).toHaveLength(2)
    c.resetGallery()
    c.setLayoutMode('system')
    c.nearStar('folder:B')
    expect(asked.at(-1)).toBe('folder:B')
    c.dispose()
  })

  it('finds the star the camera is closest to for Shift+G', () => {
    const c = new BrainController()
    c.layoutMode = 'system'
    expect(c.nearestStar()).toBeNull()
    c.graph = starGraph()
    c.camera = { setRange() {}, flyTo() {}, reset() {}, orbit() {}, dolly() {}, truck() {}, setEnabled() {}, setShift() {}, getPosition: (out) => ((out[0] = 9), (out[1] = 0), (out[2] = 0), out) }
    const n = c.graph.nodes.length
    c.engine.positions = new Float32Array(n * 3)
    c.engine.extents = new Float32Array(n).fill(10)
    const star = c.graph.index.get('folder:Projects/PORTALz')!
    c.engine.positions[star * 3] = 10
    expect(c.nearestStar()).toBe('folder:Projects/PORTALz')
    c.dispose()
  })
})

function starGraph(gallery: string | null = null): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries({
    'Projects/PORTALz.md': '---\ntype: project\n---\n# PORTALz\n',
    'Projects/PORTALz/Art/Moodboard.md': '# Moodboard\n',
  })) {
    const note = parseNote({ path, content })
    notes.set(note.meta.id, note)
  }
  return buildGraph(notes, {
    images: {
      all: assetMap([
        { path: 'Projects/PORTALz/Art/gate.png', mtime: 3 },
        { path: 'Projects/PORTALz/Art/old.png', mtime: 1 },
      ]),
      moons: true,
      maxPerFolder: 1,
      gallery,
    },
    folders: { all: new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
  })
}

/** Stands in for the layout worker: records what the engine sends, replies on demand. */
class FakeWorker {
  static last: FakeWorker | null = null
  sent: MainToWorker[] = []
  onmessage: ((ev: { data: WorkerToMain }) => void) | null = null
  constructor() {
    FakeWorker.last = this
  }
  postMessage(msg: MainToWorker): void {
    this.sent.push(msg)
  }
  terminate(): void {}
  reply(msg: WorkerToMain): void {
    this.onmessage?.({ data: msg })
  }
}

describe('LayoutEngine and the gallery', () => {
  beforeEach(() => vi.stubGlobal('Worker', FakeWorker))
  afterEach(() => vi.unstubAllGlobals())

  it('sends the cards to the worker and keeps their sizes across a rebuild', async () => {
    const { LayoutEngine } = await import('../src/layout/LayoutEngine')
    const engine = new LayoutEngine()
    const worker = FakeWorker.last!
    const g = starGraph('Projects/PORTALz')
    expect(g.gallery).toMatchObject({ cards: 2 })
    engine.setGraph(g, 'system')
    const sent = worker.sent.at(-1) as Extract<MainToWorker, { type: 'graph' }>
    const star = g.index.get('folder:Projects/PORTALz')!
    const byId = new Map(sent.nodes.map((n) => [n.id, n]))
    expect(byId.get('image:Projects/PORTALz/Art/gate.png')?.gallery).toEqual({ anchor: star, rank: 0, only: false })
    expect(byId.get('image:Projects/PORTALz/Art/old.png')?.gallery).toEqual({ anchor: star, rank: 1, only: true })
    expect(sent.nodes.filter((n: LayoutNodeInput) => n.gallery)).toHaveLength(2)

    const n = g.nodes.length
    const cards = new Float32Array(n)
    const extent = new Float32Array(n).fill(3)
    const old = g.index.get('image:Projects/PORTALz/Art/old.png')!
    cards[old] = 7
    worker.reply({ type: 'ready', generation: 1 })
    worker.reply({ type: 'rings', rings: new Float32Array(0), cards, extent, generation: 1 })
    expect(engine.cards[old]).toBe(7)
    expect(engine.extents).toBe(extent)

    // Rebuilt with one more note: the card keeps its size until the worker answers.
    const next = starGraphPlus()
    engine.setGraph(next, 'system')
    expect(engine.cards[next.index.get('image:Projects/PORTALz/Art/old.png')!]).toBe(7)
    expect(engine.extents.length).toBe(next.nodes.length)
    // A reply that does not fit the node set is dropped.
    worker.reply({ type: 'rings', rings: new Float32Array(0), cards: new Float32Array(1), extent: new Float32Array(1), generation: 2 })
    expect(engine.cards.length).toBe(0)
    engine.setMode('constellation')
    expect([engine.cards.length, engine.extents.length]).toEqual([0, 0])
    engine.dispose()
  })
})

function starGraphPlus(): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries({
    'Projects/PORTALz.md': '---\ntype: project\n---\n# PORTALz\n',
    'Projects/PORTALz/Art/Moodboard.md': '# Moodboard\n',
    'Projects/PORTALz/Art/A new idea.md': '# A new idea\n',
  })) {
    const note = parseNote({ path, content })
    notes.set(note.meta.id, note)
  }
  return buildGraph(notes, {
    images: {
      all: assetMap([
        { path: 'Projects/PORTALz/Art/gate.png', mtime: 3 },
        { path: 'Projects/PORTALz/Art/old.png', mtime: 1 },
      ]),
      moons: true,
      maxPerFolder: 1,
      gallery: 'Projects/PORTALz',
    },
    folders: { all: new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
  })
}
