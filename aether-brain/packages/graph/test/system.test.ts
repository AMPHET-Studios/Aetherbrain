import { describe, expect, it } from 'vitest'
import { computeSystemLayout, systemPositions, type SystemInput, type SystemLayout } from '../src/layout/system'

interface Spec {
  id: string
  parent: string | null
  kind?: 0 | 1 | 2 | 3 | 4
  role?: -1 | 0 | 1 | 2 | 3
  radius?: number
}

function input(specs: Spec[]): SystemInput {
  const index = new Map(specs.map((s, i) => [s.id, i]))
  const n = specs.length
  const parent = new Int32Array(n)
  const kind = new Uint8Array(n)
  const role = new Int8Array(n)
  const radius = new Float32Array(n)
  specs.forEach((s, i) => {
    parent[i] = s.parent === null ? -1 : (index.get(s.parent) ?? -1)
    kind[i] = s.kind ?? 0
    role[i] = s.role ?? -1
    radius[i] = s.radius ?? 1
  })
  return { parent, kind, role, radius, ids: specs.map((s) => s.id) }
}

function folder(id: string, parent: string | null, radius = 2.5): Spec {
  return { id, parent, kind: 2, role: parent === null ? 0 : 3, radius }
}

function notes(parent: string, count: number, prefix = parent): Spec[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}/note ${i}`, parent, radius: 1 + (i % 5) * 0.4 }))
}

/** A small vault: root → planets (with moons, sub-planets, a ghost moon) → notes. */
function vault(): Spec[] {
  return [
    folder('folder:', null, 8),
    folder('folder:Projects', 'folder:', 4),
    { ...folder('folder:Projects/PORTALz', 'folder:Projects', 5.5), role: 2 },
    folder('folder:Projects/PORTALz/Concepts', 'folder:Projects/PORTALz', 3),
    folder('folder:Projects/PORTALz/Renders', 'folder:Projects/PORTALz', 2),
    folder('folder:Areas', 'folder:', 3),
    folder('folder:Empty', 'folder:', 1.6),
    ...notes('folder:', 6),
    ...notes('folder:Projects/PORTALz', 4),
    ...notes('folder:Projects/PORTALz/Concepts', 9),
    ...notes('folder:Areas', 12),
    { id: 'Areas/Hub', parent: 'folder:Areas', radius: 3 },
    { id: 'ghost:Missing', parent: 'Areas/Hub', kind: 1, radius: 0.8 },
    { id: 'ghost:Other', parent: 'Areas/Hub', kind: 1, radius: 0.8 },
  ]
}

/** A deep synthetic tree: root → 12 mounts → folders → sub-folders → notes. */
function bigTree(total: number): Spec[] {
  const specs: Spec[] = [folder('folder:', null, 8)]
  const folders: string[] = []
  for (let m = 0; m < 12; m++) {
    const mount = `folder:M${m}`
    specs.push({ ...folder(mount, 'folder:', 6.5), role: 1 })
    for (let f = 0; f < 8; f++) {
      const id = `${mount}/F${f}`
      specs.push(folder(id, mount, 3))
      folders.push(id)
      for (let g = 0; g < 3; g++) {
        const sub = `${id}/S${g}`
        specs.push(folder(sub, id, 2))
        folders.push(sub)
      }
    }
  }
  let k = 0
  while (specs.length < total) {
    const parent = folders[(k * 7919) % folders.length]!
    specs.push({ id: `note ${k}`, parent, radius: 1 + (k % 7) * 0.3 })
    k++
  }
  return specs
}

function positionsAt(layout: SystemLayout, t: number, offsets?: Float32Array): Float32Array {
  const out = new Float32Array(layout.order.length * 3)
  systemPositions(layout, t, out, offsets)
  return out
}

function dist(p: Float32Array, a: number, b: number): number {
  return Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!)
}

function allFinite(arr: ArrayLike<number>): boolean {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) return false
  return true
}

/** Every pair of siblings (same parent) is at least the sum of their extents apart. */
function expectNoSiblingOverlap(layout: SystemLayout, pos: Float32Array): void {
  const byParent = new Map<number, number[]>()
  layout.parent.forEach((p, i) => {
    const list = byParent.get(p) ?? []
    list.push(i)
    byParent.set(p, list)
  })
  for (const [, kids] of byParent) {
    for (let a = 0; a < kids.length; a++) {
      for (let b = a + 1; b < kids.length; b++) {
        const i = kids[a]!
        const j = kids[b]!
        const need = layout.extent[i]! + layout.extent[j]!
        expect(dist(pos, i, j)).toBeGreaterThanOrEqual(need - 1e-3)
      }
    }
  }
}

describe('computeSystemLayout', () => {
  it('is deterministic for the same input', () => {
    const a = computeSystemLayout(input(vault()))
    const b = computeSystemLayout(input(vault()))
    for (const key of ['parent', 'order', 'orbitRadius', 'phase', 'speed', 'plane', 'shell', 'shellDir', 'rings', 'extent'] as const) {
      expect(Array.from(b[key])).toEqual(Array.from(a[key]))
    }
    expect(Array.from(positionsAt(b, 12.5))).toEqual(Array.from(positionsAt(a, 12.5)))
  })

  it('produces no NaN or Infinity', () => {
    const layout = computeSystemLayout(input(vault()))
    for (const arr of [layout.orbitRadius, layout.phase, layout.speed, layout.plane, layout.shellDir, layout.rings, layout.extent]) {
      expect(allFinite(arr)).toBe(true)
    }
    for (const t of [0, 1.5, 1000]) expect(allFinite(positionsAt(layout, t))).toBe(true)
  })

  it('keeps the order parents-first and visits every node once', () => {
    const specs = vault()
    const layout = computeSystemLayout(input(specs))
    expect(new Set(layout.order).size).toBe(specs.length)
    const seen = new Set<number>()
    for (const i of layout.order) {
      const p = layout.parent[i]!
      if (p >= 0) expect(seen.has(p)).toBe(true)
      seen.add(i)
    }
  })

  it('places ring children at orbitRadius from their parent, at t = 0 and later', () => {
    const layout = computeSystemLayout(input(vault()))
    for (const t of [0, 7.25]) {
      const pos = positionsAt(layout, t)
      layout.parent.forEach((p, i) => {
        if (p < 0) return
        expect(layout.orbitRadius[i]!).toBeGreaterThan(0)
        expect(dist(pos, i, p)).toBeCloseTo(layout.orbitRadius[i]!, 3)
      })
    }
    // The lone root sits at the origin.
    const pos = positionsAt(layout, 0)
    expect([pos[0], pos[1], pos[2]]).toEqual([0, 0, 0])
  })

  it('never overlaps siblings on rings or shells, even while orbiting', () => {
    const layout = computeSystemLayout(input(vault()))
    for (const t of [0, 3.3, 41]) expectNoSiblingOverlap(layout, positionsAt(layout, t))
  })

  it('keeps crowded rings of big planets apart (chord, not arc length)', () => {
    // A small parent with many large sub-systems: arc-length packing would overlap them.
    const specs: Spec[] = [folder('folder:', null, 1)]
    for (let p = 0; p < 7; p++) {
      specs.push(folder(`folder:P${p}`, 'folder:', 3))
      specs.push(...notes(`folder:P${p}`, 20))
    }
    const layout = computeSystemLayout(input(specs))
    expectNoSiblingOverlap(layout, positionsAt(layout, 0))
  })

  it('moves children with their parent: moons stay out of the parent body', () => {
    const layout = computeSystemLayout(input(vault()))
    const specs = vault()
    const pos = positionsAt(layout, 2)
    layout.parent.forEach((p, i) => {
      if (p < 0) return
      const parentBody = (specs[p]!.radius ?? 1) * 1.6 + 1
      expect(dist(pos, i, p)).toBeGreaterThanOrEqual(parentBody + layout.extent[i]!)
    })
  })

  it('puts more than 24 leaf moons on a shell, 24 or fewer on rings', () => {
    const many = [folder('folder:', null, 4), ...notes('folder:', 30)]
    const a = computeSystemLayout(input(many))
    for (let i = 1; i < many.length; i++) expect(a.shell[i]).toBe(1)
    expect(a.rings.length).toBe(0)
    const pos = positionsAt(a, 5)
    for (let i = 1; i < many.length; i++) {
      const dx = a.shellDir[i * 3]!
      const dy = a.shellDir[i * 3 + 1]!
      const dz = a.shellDir[i * 3 + 2]!
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 5)
      expect(dist(pos, i, 0)).toBeCloseTo(a.orbitRadius[i]!, 3)
    }
    expectNoSiblingOverlap(a, pos)

    const few = [folder('folder:', null, 4), ...notes('folder:', 24)]
    const b = computeSystemLayout(input(few))
    for (let i = 1; i < few.length; i++) expect(b.shell[i]).toBe(0)
    expect(b.rings.length).toBeGreaterThan(0)

    // Planets beside a shell of moons go on rings outside it.
    const mixed = [folder('folder:', null, 4), ...notes('folder:', 40), folder('folder:Planet', 'folder:', 2), ...notes('folder:Planet', 3)]
    const c = computeSystemLayout(input(mixed))
    const planet = 41
    expect(c.shell[planet]).toBe(0)
    expect(c.orbitRadius[planet]!).toBeGreaterThan(c.orbitRadius[1]! + c.extent[planet]!)
    expectNoSiblingOverlap(c, positionsAt(c, 0))
  })

  it('emits 6 floats per ring with valid parents, radii and unit quaternions', () => {
    const specs = vault()
    const layout = computeSystemLayout(input(specs))
    const rings = layout.rings
    expect(rings.length % 6).toBe(0)
    expect(rings.length).toBeGreaterThan(0)
    const radiiByParent = new Map<number, Set<number>>()
    layout.parent.forEach((p, i) => {
      if (p < 0 || layout.shell[i]) return
      const set = radiiByParent.get(p) ?? new Set<number>()
      set.add(layout.orbitRadius[i]!)
      radiiByParent.set(p, set)
    })
    let count = 0
    for (let k = 0; k < rings.length; k += 6) {
      const p = rings[k]!
      expect(Number.isInteger(p)).toBe(true)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(specs.length)
      // Every ring belongs to a parent that has ring children at exactly that radius.
      expect(radiiByParent.get(p)?.has(rings[k + 1]!)).toBe(true)
      expect(Math.hypot(rings[k + 2]!, rings[k + 3]!, rings[k + 4]!, rings[k + 5]!)).toBeCloseTo(1, 5)
      count++
    }
    let expected = 0
    for (const set of radiiByParent.values()) expected += set.size
    expect(count).toBe(expected)
    // The PORTALz project folder (index 2) has two planets and four moons: rings around it.
    expect(radiiByParent.get(2)?.size).toBeGreaterThan(0)
  })

  it('tilts orbit planes by at most 0.45 rad and alternates direction per depth', () => {
    const layout = computeSystemLayout(input(vault()))
    for (let i = 0; i < layout.parent.length; i++) {
      const qw = layout.plane[i * 4 + 3]!
      expect(2 * Math.acos(Math.min(1, qw))).toBeLessThanOrEqual(0.45 + 1e-6)
    }
    // Root (depth 0) children turn one way, grandchildren the other.
    expect(layout.speed[1]!).toBeGreaterThan(0)
    expect(layout.speed[2]!).toBeLessThan(0)
    expect(layout.speed[0]!).toBe(0)
  })

  it('moves a whole subtree with its offset', () => {
    const specs = vault()
    const layout = computeSystemLayout(input(specs))
    const plain = positionsAt(layout, 3)
    const offsets = new Float32Array(specs.length * 3)
    const moved = 1 // folder:Projects
    offsets[moved * 3] = 10
    offsets[moved * 3 + 1] = -5
    offsets[moved * 3 + 2] = 3
    const shifted = positionsAt(layout, 3, offsets)
    const inSubtree = (i: number): boolean => {
      for (let cur = i; cur >= 0; cur = layout.parent[cur]!) if (cur === moved) return true
      return false
    }
    for (let i = 0; i < specs.length; i++) {
      const d = inSubtree(i) ? [10, -5, 3] : [0, 0, 0]
      for (let c = 0; c < 3; c++) expect(shifted[i * 3 + c]! - plain[i * 3 + c]!).toBeCloseTo(d[c]!, 3)
    }
    expect(inSubtree(3)).toBe(true)
  })

  it('handles several roots on static rings around the origin', () => {
    const specs = [folder('folder:A', null, 6), ...notes('folder:A', 5), folder('folder:B', null, 6), ...notes('folder:B', 30), { id: 'loose', parent: null }]
    const layout = computeSystemLayout(input(specs))
    const roots = [0, 6, 37]
    for (const r of roots) {
      expect(layout.parent[r]).toBe(-1)
      expect(layout.speed[r]).toBe(0)
    }
    const a = positionsAt(layout, 0)
    const b = positionsAt(layout, 20)
    expect(allFinite(a)).toBe(true)
    for (const r of roots) for (let c = 0; c < 3; c++) expect(b[r * 3 + c]).toBeCloseTo(a[r * 3 + c]!, 4)
    for (let x = 0; x < roots.length; x++) {
      for (let y = x + 1; y < roots.length; y++) {
        const i = roots[x]!
        const j = roots[y]!
        expect(dist(a, i, j)).toBeGreaterThanOrEqual(layout.extent[i]! + layout.extent[j]! - 1e-3)
      }
    }
    expect(layout.rings.length % 6).toBe(0)
    for (let k = 0; k < layout.rings.length; k += 6) expect(layout.rings[k]!).toBeGreaterThanOrEqual(0)
  })

  it('breaks parent cycles and ignores invalid parents', () => {
    const inp = input([folder('folder:', null, 8), { id: 'a', parent: null }, { id: 'b', parent: null }, { id: 'c', parent: null }, { id: 'd', parent: null }])
    // a → b → c → a is a loop; d points to itself; 'e' would be out of range.
    inp.parent.set([-1, 2, 3, 1, 4])
    const layout = computeSystemLayout(inp)
    expect(new Set(layout.order).size).toBe(5)
    let loopRoots = 0
    for (const i of [1, 2, 3]) if (layout.parent[i] === -1) loopRoots++
    expect(loopRoots).toBe(1)
    expect(layout.parent[4]).toBe(-1)
    const inp2 = input([folder('folder:', null, 8), { id: 'x', parent: 'folder:' }])
    inp2.parent[1] = 99
    expect(computeSystemLayout(inp2).parent[1]).toBe(-1)
    expect(allFinite(positionsAt(layout, 1))).toBe(true)
  })

  it('handles an empty graph and a lone root', () => {
    const empty = computeSystemLayout(input([]))
    expect(empty.order.length).toBe(0)
    expect(empty.rings.length).toBe(0)
    systemPositions(empty, 1, new Float32Array(0))
    const lone = computeSystemLayout(input([folder('folder:', null, 8)]))
    expect(Array.from(positionsAt(lone, 4))).toEqual([0, 0, 0])
    expect(lone.extent[0]).toBeCloseTo(8 * 1.6 + 1, 5)
  })

  it('hangs the Today hub still, straight above the root sun, with no ring', () => {
    const hub: Spec = { id: 'today:', parent: 'folder:', kind: 3, radius: 4.6 }
    const specs = [...vault(), hub]
    const h = specs.length - 1
    const layout = computeSystemLayout(input(specs))
    const height = 8 * 2.4 + 30
    expect(layout.parent[h]).toBe(0)
    expect(layout.speed[h]).toBe(0)
    expect(layout.orbitRadius[h]).toBeCloseTo(height, 5)
    for (const t of [0, 4.5, 300]) {
      const pos = positionsAt(layout, t)
      expect(pos[h * 3]!).toBeCloseTo(0, 4)
      expect(pos[h * 3 + 1]!).toBeCloseTo(height, 4)
      expect(pos[h * 3 + 2]!).toBeCloseTo(0, 4)
    }
    for (let k = 0; k < layout.rings.length; k += 6) {
      if (layout.rings[k] === 0) expect(layout.rings[k + 1]).not.toBeCloseTo(height, 3)
    }

    // Everything else lays out exactly as without the hub, and the sun does not grow.
    const plain = computeSystemLayout(input(vault()))
    expect(Array.from(layout.rings)).toEqual(Array.from(plain.rings))
    expect(Array.from(layout.extent.subarray(0, h))).toEqual(Array.from(plain.extent))
    const a = positionsAt(layout, 7.5)
    const b = positionsAt(plain, 7.5)
    expect(Array.from(a.subarray(0, h * 3))).toEqual(Array.from(b))
  })

  it('hangs the hub clear above a shell of many loose root notes', () => {
    // Around 140 of these moons the shell's radius is the hub's usual height; with more, the shell would enclose it.
    for (const m of [60, 130, 142, 150, 400]) {
      const specs: Spec[] = [folder('folder:', null, 8), ...notes('folder:', m), { id: 'today:', parent: 'folder:', kind: 3, radius: 4.6 }]
      const h = specs.length - 1
      const layout = computeSystemLayout(input(specs))
      expect(layout.speed[h]).toBe(0)
      for (const t of [0, 3.3, 17, 41]) {
        const pos = positionsAt(layout, t)
        const hx = pos[h * 3]!
        const hy = pos[h * 3 + 1]!
        const hz = pos[h * 3 + 2]!
        expect(hx).toBeCloseTo(0, 4)
        expect(hz).toBeCloseTo(0, 4)
        let closest = Infinity
        let top = -Infinity
        for (let i = 1; i < h; i++) {
          closest = Math.min(closest, Math.hypot(pos[i * 3]! - hx, pos[i * 3 + 1]! - hy, pos[i * 3 + 2]! - hz))
          top = Math.max(top, pos[i * 3 + 1]!)
        }
        // Above the shell, not buried in it.
        expect(hy, `m=${m} t=${t}`).toBeGreaterThan(top + 2.6)
        // Never inside a moon: at least the hub's and the largest moon's radii apart.
        expect(closest, `m=${m} t=${t}`).toBeGreaterThan(4.6 + 2.6)
      }
    }
  })

  it('moves the hub with a dragged sun and never makes it a second root', () => {
    const specs = [...vault(), { id: 'today:', parent: null, kind: 3 as const, radius: 4.6 }]
    const h = specs.length - 1
    const layout = computeSystemLayout(input(specs))
    expect(layout.parent[h]).toBe(0)
    expect(Array.from(layout.order).filter((i) => layout.parent[i] === -1)).toEqual([0])
    const offsets = new Float32Array(specs.length * 3)
    offsets[0] = 12
    offsets[2] = -7
    const pos = positionsAt(layout, 2, offsets)
    expect(pos[h * 3]!).toBeCloseTo(12, 4)
    expect(pos[h * 3 + 1]!).toBeCloseTo(8 * 2.4 + 30, 4)
    expect(pos[h * 3 + 2]!).toBeCloseTo(-7, 4)

    // Several roots: the hub joins the first real one, which keeps its static ring.
    const multi = [folder('folder:A', null, 6), ...notes('folder:A', 3), { id: 'today:', parent: null, kind: 3 as const, radius: 4.6 }, folder('folder:B', null, 5)]
    const m = computeSystemLayout(input(multi))
    expect(m.parent[4]).toBe(0)
    const roots = Array.from(m.order).filter((i) => m.parent[i] === -1)
    expect(roots.sort()).toEqual([0, 5])
    const mp = positionsAt(m, 9)
    expect(mp[4 * 3]!).toBeCloseTo(mp[0]!, 4)
    expect(mp[4 * 3 + 1]! - mp[1]!).toBeCloseTo(6 * 2.4 + 30, 4)
    expect(mp[4 * 3 + 2]!).toBeCloseTo(mp[2]!, 4)

    // A lone hub (nothing else in the graph) is simply the root at the origin.
    const lone = computeSystemLayout(input([{ id: 'today:', parent: null, kind: 3, radius: 4.6 }]))
    expect(Array.from(positionsAt(lone, 3))).toEqual([0, 0, 0])
  })

  it('lays images out as leaf moons, like notes', () => {
    const images = (parent: string, count: number): Spec[] =>
      Array.from({ length: count }, (_, i) => ({ id: `image:${parent}/art ${i}.png`, parent, kind: 4 as const, radius: 1.4 }))
    const specs = [folder('folder:', null, 8), folder('folder:Art', 'folder:', 3), ...images('folder:Art', 5), ...notes('folder:Art', 2), folder('folder:Art/Sub', 'folder:Art', 2)]
    const layout = computeSystemLayout(input(specs))
    const sub = specs.length - 1
    for (let i = 2; i < 7; i++) {
      expect(layout.parent[i]).toBe(1)
      expect(layout.shell[i]).toBe(0)
      // Moons ride the inner rings; the sub-folder planet orbits outside them.
      expect(layout.orbitRadius[i]!).toBeLessThan(layout.orbitRadius[sub]!)
    }
    expectNoSiblingOverlap(layout, positionsAt(layout, 1.25))
    // Past 24 leaf moons, images join the notes on a shell.
    const crowd = computeSystemLayout(input([folder('folder:', null, 8), ...images('folder:', 20), ...notes('folder:', 10)]))
    for (let i = 1; i <= 30; i++) expect(crowd.shell[i]).toBe(1)
  })

  it('lays out a 5,000-node tree in well under 100 ms', () => {
    const specs = bigTree(5000)
    expect(specs.length).toBe(5000)
    const inp = input(specs)
    const t0 = performance.now()
    const layout = computeSystemLayout(inp)
    const out = new Float32Array(specs.length * 3)
    systemPositions(layout, 0, out)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(100)
    expect(allFinite(out)).toBe(true)
    // A motion frame is far cheaper still.
    const t1 = performance.now()
    for (let f = 0; f < 30; f++) systemPositions(layout, f / 30, out)
    expect((performance.now() - t1) / 30).toBeLessThan(5)
    expectNoSiblingOverlap(layout, out)
  })
})
