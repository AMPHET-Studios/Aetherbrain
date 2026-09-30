/**
 * Solar-system layout: the folder tree laid out analytically, no physics.
 *
 * Every node orbits its structural parent. Leaf moons (notes and ghosts
 * without children of their own) sit on the inner rings, or on a Fibonacci
 * shell when there are more than 24 of them; planets (folders, notes with
 * ghost moons) sit on the outer rings, biggest first. Bodies never overlap:
 * ring radii are spaced by the extents (subtree radii) of the bodies on them,
 * and angles within a ring are allocated by extent. Orbit planes and start
 * phases come from hashes of the node ids, so the same vault always lays out
 * the same way. The Today hub (kind 3) is the exception: it hangs still,
 * straight above the root sun, outside every ring.
 *
 * Pure (no three.js) so it runs in the layout worker and in unit tests;
 * `systemPositions` allocates nothing and is called every motion frame.
 */

export interface SystemInput {
  /** Structural parent index per node, -1 for a root. */
  parent: Int32Array
  /** 0 note, 1 ghost, 2 folder, 3 the Today hub, 4 image (see `LayoutKind`). */
  kind: Uint8Array
  /** Folder role code (0 root, 1 mount, 2 project, 3 folder), -1 for non-folders. */
  role: Int8Array
  /** Visual radius per node. */
  radius: Float32Array
  /** Node ids: seed the stable orbit planes and phases. */
  ids: string[]
}

export interface SystemLayout {
  /** Parent per node as laid out: -1 for roots, out-of-range parents and parent cycles broken. */
  parent: Int32Array
  /** Parents before children. */
  order: Int32Array
  /** Distance from the parent (0 for a lone root). */
  orbitRadius: Float32Array
  /** Angle at t = 0 (rings: position on the ring; shells: rotation of the shell). */
  phase: Float32Array
  /** Angular speed in rad/s (sign = direction; 0 for roots). */
  speed: Float32Array
  /** Quaternion per node (4 floats): orientation of the orbit plane around its parent. */
  plane: Float32Array
  /** 1 when the node sits on a spherical shell (many leaf moons) instead of a ring. */
  shell: Uint8Array
  /** Unit direction (3 floats) on the shell, for shell nodes. */
  shellDir: Float32Array
  /** 6 floats per ring: parentIndex, radius, qx, qy, qz, qw (see protocol). */
  rings: Float32Array
  /** Subtree radius: the node's own body plus everything orbiting it. */
  extent: Float32Array
}

/** Clearance between neighbouring bodies and between rings. */
const GAP = 2
/** First ring radius = parent radius × this + extent + gap. */
const FIRST_RING = 2.4
/** More leaf moons than this go on a shell instead of rings. */
const SHELL_ABOVE = 24
const MAX_INCLINATION = 0.45
const TAU = Math.PI * 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/**
 * The nearest two of N points on a unit Fibonacci sphere are ≈ 3.09/√N apart;
 * sizing the shell with 3.0 keeps a small margin.
 */
const FIB_SPACING = 3.0
/** Layout kind codes (see `LayoutKind`): folders are always planets; the hub hangs apart. */
const KIND_FOLDER = 2
const KIND_TODAY = 3
/** Height of the Today hub above its parent: parent radius × FIRST_RING + this. */
const HUB_LIFT = 30
/** Quaternion component of −90° about X: turns the XZ ring into the vertical plane. */
const HALF_SQRT2 = Math.SQRT1_2

/** Angular speed of an orbit of radius r: inner orbits run faster. */
export function orbitSpeed(r: number): number {
  return 0.9 / Math.sqrt(Math.max(r, 4))
}

/** Stable hash of a string to [0, 1). FNV-1a with a murmur3 finalizer. */
function hash01(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * Angle a body of extent e needs on a ring of radius r. Neighbours placed
 * (a_1 + a_2) / 2 apart are at least e_1 + e_2 + GAP apart along the chord
 * (sin is concave on [0, π]), which a plain arc-length budget does not
 * guarantee on small, crowded rings.
 */
function ringAngle(e: number, r: number): number {
  return 2 * Math.asin(Math.min(1, (e + GAP / 2) / r))
}

/** Copy parents, drop out-of-range and self parents, and break every parent cycle. */
function sanitizeParents(input: Int32Array): Int32Array {
  const n = input.length
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const p = input[i]!
    parent[i] = p >= 0 && p < n && p !== i ? p : -1
  }
  // 0 = unvisited, 1 = on the current chain, 2 = done (reaches a root).
  const state = new Uint8Array(n)
  const chain = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (state[i] !== 0) continue
    let top = 0
    let cur = i
    while (cur >= 0 && state[cur] === 0) {
      state[cur] = 1
      chain[top++] = cur
      cur = parent[cur]!
    }
    // Walked back onto this chain: the chain loops. The node where it closes becomes a root.
    if (cur >= 0 && state[cur] === 1) parent[cur] = -1
    while (top > 0) state[chain[--top]!] = 2
  }
  return parent
}

/**
 * Lay out the structural tree as nested solar systems.
 *
 * Extents are computed bottom-up. Children of a node: leaf moons on the inner
 * rings (a Fibonacci shell when there are more than 24), planets on the outer
 * rings, biggest first. A ring takes children while their angles fit in 2π;
 * the next ring sits at r + maxExtent(this ring) + maxExtent(next ring) + gap.
 * Each parent gets a stable tilted orbit plane (inclination 0–0.45 rad, any
 * azimuth), orbits turn at 0.9/√r rad/s with the direction alternating per
 * depth. A single root sits at the origin; several roots go on static rings
 * around it.
 */
export function computeSystemLayout(input: SystemInput): SystemLayout {
  const n = input.parent.length
  const parent = sanitizeParents(input.parent)

  // The Today hub belongs to the root sun: a hub without a parent joins the
  // first root instead of becoming a second one.
  let firstRoot = -1
  for (let i = 0; i < n && firstRoot < 0; i++) if (parent[i] === -1 && input.kind[i] !== KIND_TODAY) firstRoot = i
  if (firstRoot >= 0) for (let i = 0; i < n; i++) if (parent[i] === -1 && input.kind[i] === KIND_TODAY) parent[i] = firstRoot

  // Children per node, in index order (CSR).
  const childStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const p = parent[i]!
    if (p >= 0) childStart[p + 1] = childStart[p + 1]! + 1
  }
  for (let i = 0; i < n; i++) childStart[i + 1] = childStart[i + 1]! + childStart[i]!
  const children = new Int32Array(n)
  const fill = childStart.slice(0, n)
  for (let i = 0; i < n; i++) {
    const p = parent[i]!
    if (p < 0) continue
    children[fill[p]!] = i
    fill[p] = fill[p]! + 1
  }

  // Breadth-first: parents before children, plus depth for the orbit direction.
  const order = new Int32Array(n)
  const depth = new Int32Array(n)
  let tail = 0
  for (let i = 0; i < n; i++) if (parent[i] === -1) order[tail++] = i
  const rootCount = tail
  for (let head = 0; head < tail; head++) {
    const p = order[head]!
    for (let k = childStart[p]!; k < childStart[p + 1]!; k++) {
      const c = children[k]!
      depth[c] = depth[p]! + 1
      order[tail++] = c
    }
  }

  const orbitRadius = new Float32Array(n)
  const phase = new Float32Array(n)
  const speed = new Float32Array(n)
  const plane = new Float32Array(n * 4)
  const shell = new Uint8Array(n)
  const shellDir = new Float32Array(n * 3)
  const extent = new Float32Array(n)
  const rings: number[] = []
  for (let i = 0; i < n; i++) plane[i * 4 + 3] = 1

  const bodyRadius = (i: number): number => {
    const r = input.radius[i]
    return r !== undefined && Number.isFinite(r) && r > 0 ? r : 1
  }
  const hasChildren = (i: number): boolean => childStart[i + 1]! > childStart[i]!
  const moons: number[] = []
  const planets: number[] = []
  const bySize = (a: number, b: number): number => extent[b]! - extent[a]! || a - b
  const q = [0, 0, 0, 1]

  /**
   * The Today hub over its parent: still, straight above it (a ring radius at
   * phase π/2 turned into the vertical plane), no ring, and left out of the
   * parent's extent so nothing else moves because of it.
   */
  const hangAbove = (c: number, p: number): void => {
    orbitRadius[c] = bodyRadius(p) * FIRST_RING + HUB_LIFT
    phase[c] = Math.PI / 2
    speed[c] = 0
    plane[c * 4] = -HALF_SQRT2
    plane[c * 4 + 1] = 0
    plane[c * 4 + 2] = 0
    plane[c * 4 + 3] = HALF_SQRT2
  }

  /**
   * Place `kids` around `p` (-1 = the origin, for several roots) starting at
   * `base` + extent. Returns the outer extent of the placed bodies.
   */
  const place = (p: number, kids: ArrayLike<number>, base: number, dir: number, seed: number): number => {
    moons.length = 0
    planets.length = 0
    let hub = -1
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k]!
      if (p >= 0 && input.kind[c] === KIND_TODAY) {
        hangAbove(c, p)
        hub = c
      }
      else if (!hasChildren(c) && input.kind[c] !== KIND_FOLDER) moons.push(c)
      else planets.push(c)
    }
    planets.sort(bySize)
    let outer = 0
    let ringNo = 0

    const setOrbit = (c: number, r: number, a: number, w: number): void => {
      orbitRadius[c] = r
      phase[c] = a
      speed[c] = w
      plane[c * 4] = q[0]!
      plane[c * 4 + 1] = q[1]!
      plane[c * 4 + 2] = q[2]!
      plane[c * 4 + 3] = q[3]!
    }

    const fillRings = (list: number[]): void => {
      let j = 0
      while (j < list.length) {
        const start = j
        let maxE = extent[list[j]!]!
        let r = base + maxE
        let sum = ringAngle(maxE, r)
        j++
        while (j < list.length) {
          const e = extent[list[j]!]!
          if (e > maxE) {
            // A bigger body widens the ring: re-measure everyone already on it.
            const r2 = base + e
            let s2 = ringAngle(e, r2)
            for (let k = start; k < j; k++) s2 += ringAngle(extent[list[k]!]!, r2)
            if (s2 > TAU) break
            maxE = e
            r = r2
            sum = s2
          } else {
            const a = ringAngle(e, r)
            if (sum + a > TAU) break
            sum += a
          }
          j++
        }
        // Spread the ring evenly: each body gets its share of the circle by extent.
        const scale = TAU / sum
        const w = orbitSpeed(r) * dir
        let a0 = (seed + ringNo * 0.6180339887) * TAU
        for (let k = start; k < j; k++) {
          const c = list[k]!
          const a = ringAngle(extent[c]!, r) * scale
          setOrbit(c, r, a0 + a / 2, w)
          a0 += a
        }
        if (p >= 0) rings.push(p, r, q[0]!, q[1]!, q[2]!, q[3]!)
        outer = Math.max(outer, r + maxE)
        base = r + maxE + GAP
        ringNo++
      }
    }

    if (moons.length > SHELL_ABOVE) {
      // Too many moons for rings: a Fibonacci sphere that turns rigidly.
      const m = moons.length
      let maxE = 0
      for (const c of moons) maxE = Math.max(maxE, extent[c]!)
      const R = Math.max(base + maxE, ((2 * maxE + GAP) * Math.sqrt(m)) / FIB_SPACING)
      const w = orbitSpeed(R) * dir
      const a0 = seed * TAU
      for (let k = 0; k < m; k++) {
        const c = moons[k]!
        const y = 1 - (2 * (k + 0.5)) / m
        const rr = Math.sqrt(Math.max(0, 1 - y * y))
        const th = GOLDEN_ANGLE * k
        shell[c] = 1
        shellDir[c * 3] = Math.cos(th) * rr
        shellDir[c * 3 + 1] = y
        shellDir[c * 3 + 2] = Math.sin(th) * rr
        setOrbit(c, R, a0, w)
      }
      outer = R + maxE
      base = R + maxE + GAP
      // A shell covers the poles too: the hub hangs clear above it. (Rings stay
      // within 0.45 rad of the equator, so their moons never come near the axis.)
      if (hub >= 0) orbitRadius[hub] = Math.max(orbitRadius[hub]!, R + maxE + GAP + bodyRadius(hub) * 1.6 + 1)
    } else {
      fillRings(moons)
    }
    fillRings(planets)
    return outer
  }

  // Bottom-up: children are laid out (and their extents known) before parents.
  for (let o = n - 1; o >= 0; o--) {
    const p = order[o]!
    const own = bodyRadius(p) * 1.6 + 1
    if (!hasChildren(p)) {
      extent[p] = own
      continue
    }
    const id = input.ids[p] ?? String(p)
    const inc = hash01(id, 1) * MAX_INCLINATION
    const az = hash01(id, 2) * TAU
    const s = Math.sin(inc / 2)
    q[0] = Math.cos(az) * s
    q[1] = 0
    q[2] = Math.sin(az) * s
    q[3] = Math.cos(inc / 2)
    const kids = children.subarray(childStart[p]!, childStart[p + 1]!)
    const outer = place(p, kids, bodyRadius(p) * FIRST_RING + GAP, depth[p]! % 2 === 0 ? 1 : -1, hash01(id, 3))
    extent[p] = Math.max(own, outer)
  }

  // Several roots (should not happen): static rings around the origin.
  if (rootCount > 1) {
    q[0] = 0
    q[1] = 0
    q[2] = 0
    q[3] = 1
    place(-1, order.subarray(0, rootCount), GAP, 0, 0.125)
  }

  return { parent, order, orbitRadius, phase, speed, plane, shell, shellDir, rings: new Float32Array(rings), extent }
}

/**
 * Positions at time `t` (seconds) into `out` (xyz triples, length ≥ 3n):
 * pos[i] = pos[parent] + rot(plane[i]) · ring/shell offset(t) + offsets[i].
 * `offsets` (user drags, xyz triples) move whole subtrees because children are
 * placed relative to their parent. Allocates nothing.
 */
export function systemPositions(layout: SystemLayout, t: number, out: Float32Array, offsets?: Float32Array): void {
  const { order, parent, orbitRadius, phase, speed, plane, shell, shellDir } = layout
  const n = order.length
  if (out.length < n * 3) return
  const off = offsets && offsets.length >= n * 3 ? offsets : null
  for (let o = 0; o < n; o++) {
    const i = order[o]!
    const r = orbitRadius[i]!
    const a = phase[i]! + speed[i]! * t
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    let lx: number
    let ly: number
    let lz: number
    if (shell[i] === 1) {
      const dx = shellDir[i * 3]!
      const dz = shellDir[i * 3 + 2]!
      lx = (dx * ca - dz * sa) * r
      ly = shellDir[i * 3 + 1]! * r
      lz = (dx * sa + dz * ca) * r
    } else {
      lx = ca * r
      ly = 0
      lz = sa * r
    }
    // v' = v + w·t + q × t, with t = 2 (q × v)
    const qx = plane[i * 4]!
    const qy = plane[i * 4 + 1]!
    const qz = plane[i * 4 + 2]!
    const qw = plane[i * 4 + 3]!
    const tx = 2 * (qy * lz - qz * ly)
    const ty = 2 * (qz * lx - qx * lz)
    const tz = 2 * (qx * ly - qy * lx)
    let x = lx + qw * tx + (qy * tz - qz * ty)
    let y = ly + qw * ty + (qz * tx - qx * tz)
    let z = lz + qw * tz + (qx * ty - qy * tx)
    const p = parent[i]!
    if (p >= 0) {
      x += out[p * 3]!
      y += out[p * 3 + 1]!
      z += out[p * 3 + 2]!
    }
    if (off) {
      x += off[i * 3]!
      y += off[i * 3 + 1]!
      z += off[i * 3 + 2]!
    }
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = z
  }
}
