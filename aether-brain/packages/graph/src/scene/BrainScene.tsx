import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Raycaster,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { CameraControlsImpl } from '@react-three/drei'
import type { GraphData, GraphNode, NoteId } from '@aether/core'
import { BrainController } from '../BrainController'
import { AREA_COLORS, GHOST_COLOR, nodeBaseColor, nodeRadius, tagColor } from '../theme'
import {
  NEBULA_COLORS,
  createEdgeMaterial,
  createFieldMaterial,
  createHaloMaterial,
  createNebulaMaterial,
  createNodeMaterial,
  createStarMaterial,
} from './materials'

const HOME_POS: [number, number, number] = [0, 150, 460]
const BG = '#04050d'

export interface BrainSceneProps {
  controller: BrainController
  /** Devicepixel cap; lower on integrated GPUs. */
  maxDpr?: number
  className?: string
}

/**
 * The thought-space. One InstancedMesh for neuron cores, one for halos, one
 * LineSegments for every synapse, a starfield, selective bloom, a 2D label
 * overlay and screen-space picking. Nothing here allocates per frame.
 */
export function BrainScene({ controller, maxDpr = 1.5, className }: BrainSceneProps) {
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const bloom = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.bloom,
  )
  return (
    <div className={className ?? 'absolute inset-0'} style={{ background: BG }}>
      <Canvas
        dpr={[1, maxDpr]}
        gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }}
        camera={{ fov: 55, near: 0.5, far: 4000, position: HOME_POS }}
        onCreated={({ gl }) => {
          gl.toneMapping = NoToneMapping
          gl.setClearColor(BG)
        }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <color attach="background" args={[BG]} />
        <fogExp2 attach="fog" args={[BG, 0.00085]} />
        <Backdrop />
        <Brain controller={controller} overlayRef={overlayRef} />
        <CameraRig controller={controller} />
        {bloom && (
          <EffectComposer multisampling={0} enableNormalPass={false}>
            <Bloom mipmapBlur luminanceThreshold={1.0} luminanceSmoothing={0.3} intensity={1.15} radius={0.72} levels={7} />
          </EffectComposer>
        )}
      </Canvas>
      <canvas
        ref={overlayRef}
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Camera                                                             */
/* ------------------------------------------------------------------ */

function CameraRig({ controller }: { controller: BrainController }) {
  const ref = useRef<CameraControlsImpl | null>(null)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const pos = new Vector3()
    const tgt = new Vector3()
    const shift = { value: 0 }
    const cam = camera as PerspectiveCamera
    const applyShift = (smooth: boolean) => {
      const dist = c.distance
      const halfW = Math.tan((cam.fov * Math.PI) / 360) * dist * cam.aspect
      void c.setFocalOffset(-halfW * shift.value, 0, 0, smooth)
    }
    controller.registerCamera({
      flyTo(x, y, z, distance, smooth = true) {
        c.getPosition(pos, true)
        c.getTarget(tgt, true)
        const dir = pos.sub(tgt)
        if (dir.lengthSq() < 1e-3) dir.set(0, 0.35, 1)
        dir.normalize().multiplyScalar(distance)
        void c.setLookAt(x + dir.x, y + dir.y, z + dir.z, x, y, z, smooth)
      },
      reset() {
        void c.setLookAt(HOME_POS[0], HOME_POS[1], HOME_POS[2], 0, 0, 0, true)
      },
      orbit(a, p) {
        void c.rotate(a, p, true)
      },
      dolly(d) {
        void c.dolly(d, true)
      },
      truck(x, y) {
        void c.truck(x, y, true)
      },
      setEnabled(v) {
        c.enabled = v
      },
      setShift(fraction) {
        // camera-controls' focal offset is in view space and in world units,
        // so scale by the visible half-width at the current distance and keep
        // it updated as the user dolly-zooms.
        shift.value = fraction
        applyShift(true)
      },
    })
    const onUpdate = () => shift.value !== 0 && applyShift(false)
    c.addEventListener('controlend', onUpdate)
    c.addEventListener('rest', onUpdate)
    return () => {
      c.removeEventListener('controlend', onUpdate)
      c.removeEventListener('rest', onUpdate)
      controller.registerCamera(null)
    }
  }, [controller, camera])
  return (
    <CameraControls
      ref={ref}
      makeDefault
      smoothTime={0.32}
      draggingSmoothTime={0.08}
      dollyToCursor
      minDistance={4}
      maxDistance={1800}
      dollySpeed={0.6}
      truckSpeed={1.4}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Backdrop: stars + nebula haze                                       */
/* ------------------------------------------------------------------ */

function Backdrop() {
  const stars = useMemo(() => {
    const n = 2600
    const pos = new Float32Array(n * 3)
    const size = new Float32Array(n)
    const phase = new Float32Array(n)
    let seed = 1337
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < n; i++) {
      const r = 900 + rnd() * 700
      const th = rnd() * Math.PI * 2
      const ph = Math.acos(2 * rnd() - 1)
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
      pos[i * 3 + 1] = r * Math.cos(ph)
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
      size[i] = 1.2 + rnd() * rnd() * 4
      phase[i] = rnd() * Math.PI * 2
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    g.setAttribute('aSize', new Float32BufferAttribute(size, 1))
    g.setAttribute('aPhase', new Float32BufferAttribute(phase, 1))
    const p = new Points(g, createStarMaterial())
    p.frustumCulled = false
    return p
  }, [])
  const nebulae = useMemo(() => {
    const geo = new PlaneGeometry(1, 1)
    const spots: [number, number, number, number, number][] = [
      [-700, 260, -900, 1500, 0],
      [800, -200, -1100, 1700, 1],
      [200, 500, -1300, 1400, 2],
    ]
    return spots.map(([x, y, z, s, ci]) => {
      const m = new Mesh(geo, createNebulaMaterial(NEBULA_COLORS[ci] ?? NEBULA_COLORS[0]!))
      m.position.set(x, y, z)
      m.scale.setScalar(s)
      m.renderOrder = -10
      m.frustumCulled = false
      return m
    })
  }, [])
  useFrame((_, dt) => {
    const mat = stars.material as ShaderMaterial
    mat.uniforms['uTime']!.value += dt
    stars.rotation.y += dt * 0.004
  })
  return (
    <>
      <primitive object={stars} />
      {nebulae.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* The brain                                                          */
/* ------------------------------------------------------------------ */

interface Buffers {
  graph: GraphData
  count: number
  nodes: InstancedMesh
  halos: InstancedMesh
  edges: LineSegments
  field: Mesh
  glow: InstancedBufferAttribute
  color: InstancedBufferAttribute
  edgePos: BufferAttribute
  edgeColor: BufferAttribute
  edgeHi: BufferAttribute
  edgeIdx: Uint32Array
  radii: Float32Array
  baseColors: Float32Array
  screen: Float32Array
  hubs: number[]
  ageOf: (n: GraphNode) => number
  dispose(): void
}

function buildBuffers(graph: GraphData): Buffers {
  const count = graph.nodes.length
  const sphere = new SphereGeometry(1, 16, 12)
  const plane = new PlaneGeometry(1, 1)
  const glow = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
  glow.setUsage(DynamicDrawUsage)
  const color = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
  color.setUsage(DynamicDrawUsage)
  sphere.setAttribute('aGlow', glow)
  plane.setAttribute('aGlow', glow)

  const nodes = new InstancedMesh(sphere, createNodeMaterial(), count)
  nodes.instanceMatrix.setUsage(DynamicDrawUsage)
  nodes.instanceColor = color
  nodes.frustumCulled = false
  const halos = new InstancedMesh(plane, createHaloMaterial(), count)
  halos.instanceMatrix.setUsage(DynamicDrawUsage)
  halos.instanceColor = color
  halos.frustumCulled = false
  halos.renderOrder = 2

  const edgeCount = graph.edges.length
  const edgeIdx = new Uint32Array(edgeCount * 2)
  graph.edges.forEach((e, i) => {
    edgeIdx[i * 2] = graph.index.get(e.from) ?? 0
    edgeIdx[i * 2 + 1] = graph.index.get(e.to) ?? 0
  })
  const eg = new BufferGeometry()
  const edgePos = new BufferAttribute(new Float32Array(edgeCount * 6), 3)
  edgePos.setUsage(DynamicDrawUsage)
  const edgeColor = new BufferAttribute(new Float32Array(edgeCount * 6), 3)
  const edgeHi = new BufferAttribute(new Float32Array(edgeCount * 2), 1)
  edgeHi.setUsage(DynamicDrawUsage)
  const edgeT = new Float32Array(edgeCount * 2)
  for (let i = 0; i < edgeCount; i++) edgeT[i * 2 + 1] = 1
  eg.setAttribute('position', edgePos)
  eg.setAttribute('aColor', edgeColor)
  eg.setAttribute('aHi', edgeHi)
  eg.setAttribute('aT', new BufferAttribute(edgeT, 1))
  const edges = new LineSegments(eg, createEdgeMaterial())
  edges.frustumCulled = false
  edges.renderOrder = 1

  const field = new Mesh(new SphereGeometry(1, 32, 24), createFieldMaterial(new Color('#8f7cff')))
  field.visible = false
  field.renderOrder = 3

  const radii = new Float32Array(count)
  graph.nodes.forEach((n, i) => (radii[i] = nodeRadius(n)))

  const times = graph.nodes.map((n) => n.created).filter((t): t is number => t !== null)
  const minT = times.length ? Math.min(...times) : 0
  const maxT = times.length ? Math.max(...times) : 1
  const span = Math.max(1, maxT - minT)
  const ageOf = (n: GraphNode) => (n.created === null ? 0.9 : 1 - (n.created - minT) / span)

  const hubs = graph.nodes
    .map((n, i) => ({ i, d: n.ghost ? -1 : n.degree }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 28)
    .map((x) => x.i)

  return {
    graph,
    count,
    nodes,
    halos,
    edges,
    field,
    glow,
    color,
    edgePos,
    edgeColor,
    edgeHi,
    edgeIdx,
    radii,
    baseColors: new Float32Array(count * 3),
    screen: new Float32Array(count * 4),
    hubs,
    ageOf,
    dispose() {
      sphere.dispose()
      plane.dispose()
      eg.dispose()
      ;(nodes.material as { dispose(): void }).dispose()
      ;(halos.material as { dispose(): void }).dispose()
      ;(edges.material as { dispose(): void }).dispose()
      field.geometry.dispose()
      ;(field.material as { dispose(): void }).dispose()
    },
  }
}

function Brain({ controller, overlayRef }: { controller: BrainController; overlayRef: React.RefObject<HTMLCanvasElement | null> }) {
  const graph = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.graph,
  )
  const buffers = useMemo(() => (graph ? buildBuffers(graph) : null), [graph])
  useEffect(() => () => buffers?.dispose(), [buffers])

  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const size = useThree((s) => s.size)
  const controls = useThree((s) => s.controls) as CameraControlsImpl | null

  const state = useRef({
    lastVersion: -1,
    lastFrame: -1,
    pointer: new Vector2(-1e9, -1e9),
    pointerInside: false,
    hovered: -1,
    drag: null as null | { index: number; id: NoteId; sx: number; sy: number; moved: boolean },
    time: 0,
    neighbors: new Set<number>(),
    labelSet: new Set<number>(),
  })

  /* ---- pointer events (capture phase so node-drag can pre-empt orbit) ---- */
  useEffect(() => {
    if (!buffers) return
    const el = gl.domElement
    const st = state.current
    const toLocal = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top] as const
    }
    const onMove = (e: PointerEvent) => {
      const [x, y] = toLocal(e)
      st.pointer.set(x, y)
      st.pointerInside = true
      const d = st.drag
      if (d) {
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) > 4) {
          d.moved = true
          controller.camera?.setEnabled(false)
        }
        if (d.moved) dragTo(d.index, d.id, x, y)
      }
    }
    const onLeave = () => {
      st.pointerInside = false
      st.pointer.set(-1e9, -1e9)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const [x, y] = toLocal(e)
      const i = pick(x, y)
      if (i < 0) return
      st.drag = { index: i, id: buffers.graph.nodes[i]!.id, sx: x, sy: y, moved: false }
      controller.camera?.setEnabled(false)
    }
    const onUp = () => {
      const d = st.drag
      st.drag = null
      controller.camera?.setEnabled(true)
      if (!d) return
      if (d.moved) {
        controller.engine.release(d.id, true)
      } else {
        controller.events.onSelect?.(d.id)
      }
    }
    const onDbl = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      const i = pick(e.clientX - r.left, e.clientY - r.top)
      if (i >= 0) controller.events.onOpen?.(buffers.graph.nodes[i]!.id)
    }
    const onClickEmpty = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      if (pick(e.clientX - r.left, e.clientY - r.top) < 0 && controller.selected) controller.events.onSelect?.(null)
    }
    const pick = (x: number, y: number): number => {
      const s = buffers.screen
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < buffers.count; i++) {
        const sx = s[i * 4] ?? 0
        const sy = s[i * 4 + 1] ?? 0
        const depth = s[i * 4 + 2] ?? 2
        if (depth > 1 || depth < -1) continue
        const rad = Math.max(9, (s[i * 4 + 3] ?? 0) + 5)
        const d = Math.hypot(sx - x, sy - y)
        if (d <= rad && depth < bestD) {
          bestD = depth
          best = i
        }
      }
      return best
    }
    const ray = new Raycaster()
    const ndc = new Vector2()
    const plane = new Vector3()
    const nrm = new Vector3()
    const hit = new Vector3()
    const dragTo = (index: number, id: NoteId, x: number, y: number) => {
      ndc.set((x / size.width) * 2 - 1, -(y / size.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const p = controller.engine.positions
      plane.set(p[index * 3] ?? 0, p[index * 3 + 1] ?? 0, p[index * 3 + 2] ?? 0)
      camera.getWorldDirection(nrm)
      const denom = nrm.dot(ray.ray.direction)
      if (Math.abs(denom) < 1e-6) return
      const t = plane.clone().sub(ray.ray.origin).dot(nrm) / denom
      hit.copy(ray.ray.origin).addScaledVector(ray.ray.direction, t)
      controller.engine.pin(id, hit.x, hit.y, hit.z)
    }
    el.addEventListener('pointermove', onMove, { capture: true })
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('pointerup', onUp, { capture: true })
    el.addEventListener('dblclick', onDbl)
    el.addEventListener('click', onClickEmpty)
    return () => {
      el.removeEventListener('pointermove', onMove, { capture: true })
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointerup', onUp, { capture: true })
      el.removeEventListener('dblclick', onDbl)
      el.removeEventListener('click', onClickEmpty)
    }
  }, [buffers, gl, camera, size, controller])

  /* ---- per-frame: positions, visual state, projection, labels ---- */
  const m4 = useMemo(() => new Matrix4(), [])
  const v3 = useMemo(() => new Vector3(), [])
  const camPos = useMemo(() => new Vector3(), [])

  useFrame((_, dt) => {
    if (!buffers) return
    const st = state.current
    st.time += dt
    const eng = controller.engine
    const g = buffers.graph
    const n = buffers.count
    const pos = eng.positions
    if (pos.length < n * 3) return

    for (const mat of [buffers.nodes.material, buffers.halos.material, buffers.edges.material, buffers.field.material]) {
      ;(mat as ShaderMaterial).uniforms['uTime']!.value = st.time
    }

    // Hover pick each frame (cheap; avoids doing it per pointermove event).
    let hoveredIndex = -1
    if (st.pointerInside && !st.drag) {
      const s = buffers.screen
      const px = st.pointer.x
      const py = st.pointer.y
      let bestD = Infinity
      for (let i = 0; i < n; i++) {
        const depth = s[i * 4 + 2] ?? 2
        if (depth > 1 || depth < -1) continue
        const rad = Math.max(9, (s[i * 4 + 3] ?? 0) + 5)
        const d = Math.hypot((s[i * 4] ?? 0) - px, (s[i * 4 + 1] ?? 0) - py)
        if (d <= rad && depth < bestD) {
          bestD = depth
          hoveredIndex = i
        }
      }
    }
    if (hoveredIndex !== st.hovered) {
      st.hovered = hoveredIndex
      const id = hoveredIndex >= 0 ? (g.nodes[hoveredIndex]?.id ?? null) : null
      controller.setHovered(id)
      controller.events.onHover?.(id)
      gl.domElement.style.cursor = id ? 'pointer' : ''
    }

    const versionChanged = controller.version !== st.lastVersion
    const positionsChanged = eng.frame !== st.lastFrame
    st.lastVersion = controller.version
    st.lastFrame = eng.frame

    if (versionChanged) recolor(buffers, controller, st.neighbors, st.labelSet)

    const selI = controller.selected ? (g.index.get(controller.selected) ?? -1) : -1
    const hovI = st.hovered

    if (positionsChanged || versionChanged) {
      // Instance matrices for cores + halos.
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3] ?? 0
        const y = pos[i * 3 + 1] ?? 0
        const z = pos[i * 3 + 2] ?? 0
        let r = buffers.radii[i] ?? 1
        if (i === selI) r *= 1.35
        else if (i === hovI) r *= 1.2
        m4.makeScale(r, r, r)
        m4.setPosition(x, y, z)
        buffers.nodes.setMatrixAt(i, m4)
        const h = r * 3.2
        m4.makeScale(h, h, h)
        m4.setPosition(x, y, z)
        buffers.halos.setMatrixAt(i, m4)
      }
      buffers.nodes.instanceMatrix.needsUpdate = true
      buffers.halos.instanceMatrix.needsUpdate = true
      // Edge endpoints.
      const ep = buffers.edgePos.array as Float32Array
      const idx = buffers.edgeIdx
      for (let e = 0; e < idx.length; e++) {
        const ni = idx[e] ?? 0
        ep[e * 3] = pos[ni * 3] ?? 0
        ep[e * 3 + 1] = pos[ni * 3 + 1] ?? 0
        ep[e * 3 + 2] = pos[ni * 3 + 2] ?? 0
      }
      buffers.edgePos.needsUpdate = true

      // Tag field.
      updateField(buffers, controller)
    }

    // Project to screen for picking + labels.
    camera.getWorldPosition(camPos)
    const halfH = size.height / 2
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360)
    const s = buffers.screen
    for (let i = 0; i < n; i++) {
      v3.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0)
      const dist = v3.distanceTo(camPos)
      v3.project(camera)
      s[i * 4] = (v3.x * 0.5 + 0.5) * size.width
      s[i * 4 + 1] = (1 - (v3.y * 0.5 + 0.5)) * size.height
      s[i * 4 + 2] = v3.z
      s[i * 4 + 3] = ((buffers.radii[i] ?? 1) * halfH) / (dist * tanHalf)
    }

    drawLabels(overlayRef.current, buffers, controller, st.labelSet, hovI, selI, size.width, size.height)
  })

  useEffect(() => {
    // Keep controls enabled in sync if the component re-mounts mid-drag.
    return () => {
      if (controls) controls.enabled = true
    }
  }, [controls])

  if (!buffers) return null
  return (
    <>
      <primitive object={buffers.edges} />
      <primitive object={buffers.nodes} />
      <primitive object={buffers.halos} />
      <primitive object={buffers.field} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Visual state                                                       */
/* ------------------------------------------------------------------ */

const IDLE_GLOW = 1.35
const NEIGHBOR_GLOW = 1.5
const HOVER_GLOW = 1.7
const SELECTED_GLOW = 1.9

function recolor(b: Buffers, c: BrainController, neighbors: Set<number>, labelSet: Set<number>): void {
  const g = b.graph
  const n = b.count
  const colors = b.color.array as Float32Array
  const glow = b.glow.array as Float32Array
  const base = b.baseColors
  const selI = c.selected ? (g.index.get(c.selected) ?? -1) : -1
  const hovI = c.hovered ? (g.index.get(c.hovered) ?? -1) : -1
  const focusI = selI >= 0 ? selI : hovI

  neighbors.clear()
  if (focusI >= 0) {
    const id = g.nodes[focusI]!.id
    for (const o of g.outlinks.get(id) ?? []) {
      const i = g.index.get(o)
      if (i !== undefined) neighbors.add(i)
    }
    for (const o of g.backlinks.get(id) ?? []) {
      const i = g.index.get(o)
      if (i !== undefined) neighbors.add(i)
    }
  }

  const highlight = c.highlight
  const hasHighlight = highlight !== null
  for (let i = 0; i < n; i++) {
    const node = g.nodes[i]!
    const col = nodeBaseColor(node, c.colorMode, c.activeTag, b.ageOf)
    base[i * 3] = col.r
    base[i * 3 + 1] = col.g
    base[i * 3 + 2] = col.b
    let gl = IDLE_GLOW
    if (i === selI) gl = SELECTED_GLOW
    else if (i === hovI) gl = HOVER_GLOW
    else if (neighbors.has(i)) gl = NEIGHBOR_GLOW
    if (node.ghost) gl *= 0.55
    let dim = 1
    if (hasHighlight && !highlight.has(node.id)) dim = 0.12
    else if (focusI >= 0 && i !== focusI && !neighbors.has(i)) dim = selI >= 0 ? 0.32 : 0.6
    colors[i * 3] = col.r
    colors[i * 3 + 1] = col.g
    colors[i * 3 + 2] = col.b
    glow[i * 3] = gl
    glow[i * 3 + 1] = dim
    glow[i * 3 + 2] = (i * 0.618) % 6.283
  }
  b.color.needsUpdate = true
  b.glow.needsUpdate = true

  // Edge colors + highlight.
  const ec = b.edgeColor.array as Float32Array
  const eh = b.edgeHi.array as Float32Array
  const idx = b.edgeIdx
  for (let e = 0; e < idx.length / 2; e++) {
    const a = idx[e * 2] ?? 0
    const z = idx[e * 2 + 1] ?? 0
    for (const [k, ni] of [[0, a], [1, z]] as const) {
      const v = e * 2 + k
      ec[v * 3] = base[ni * 3] ?? 1
      ec[v * 3 + 1] = base[ni * 3 + 1] ?? 1
      ec[v * 3 + 2] = base[ni * 3 + 2] ?? 1
    }
    let hi = 0
    if (focusI >= 0 && (a === focusI || z === focusI)) hi = 1
    else if (hasHighlight && !(highlight.has(g.nodes[a]!.id) && highlight.has(g.nodes[z]!.id))) hi = -1
    else if (focusI >= 0) hi = -1
    eh[e * 2] = hi
    eh[e * 2 + 1] = hi
  }
  b.edgeColor.needsUpdate = true
  b.edgeHi.needsUpdate = true

  // Label candidates: focus + neighbors, hubs, small highlight sets.
  labelSet.clear()
  if (focusI >= 0) labelSet.add(focusI)
  for (const i of neighbors) if (labelSet.size < 70) labelSet.add(i)
  if (hasHighlight && highlight.size <= 80) {
    for (const id of highlight) {
      const i = g.index.get(id)
      if (i !== undefined) labelSet.add(i)
    }
  } else if (c.hubLabels) {
    for (const i of b.hubs) labelSet.add(i)
  }
}

const _centroid = new Vector3()
function updateField(b: Buffers, c: BrainController): void {
  const tag = c.activeTag
  if (!tag) {
    b.field.visible = false
    return
  }
  const pos = c.engine.positions
  const g = b.graph
  let count = 0
  _centroid.set(0, 0, 0)
  for (let i = 0; i < b.count; i++) {
    if (!g.nodes[i]!.tags.includes(tag)) continue
    _centroid.x += pos[i * 3] ?? 0
    _centroid.y += pos[i * 3 + 1] ?? 0
    _centroid.z += pos[i * 3 + 2] ?? 0
    count++
  }
  if (count === 0) {
    b.field.visible = false
    return
  }
  _centroid.divideScalar(count)
  let spread = 0
  for (let i = 0; i < b.count; i++) {
    if (!g.nodes[i]!.tags.includes(tag)) continue
    const dx = (pos[i * 3] ?? 0) - _centroid.x
    const dy = (pos[i * 3 + 1] ?? 0) - _centroid.y
    const dz = (pos[i * 3 + 2] ?? 0) - _centroid.z
    spread += dx * dx + dy * dy + dz * dz
  }
  const radius = Math.max(14, Math.sqrt(spread / count) * 1.35 + 8)
  b.field.visible = true
  b.field.position.copy(_centroid)
  b.field.scale.setScalar(radius)
  const mat = b.field.material as ShaderMaterial
  ;(mat.uniforms['uColor']!.value as Color).set(tagColor(tag))
}

/* ------------------------------------------------------------------ */
/* Labels                                                             */
/* ------------------------------------------------------------------ */

function drawLabels(
  canvas: HTMLCanvasElement | null,
  b: Buffers,
  c: BrainController,
  labelSet: Set<number>,
  hovI: number,
  selI: number,
  width: number,
  height: number,
): void {
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const W = Math.round(width * dpr)
  const H = Math.round(height * dpr)
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W
    canvas.height = H
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  const s = b.screen
  const g = b.graph
  const highlight = c.highlight

  const draw = (i: number, emphasis: number) => {
    const depth = s[i * 4 + 2] ?? 2
    if (depth > 1 || depth < -1) return
    const x = s[i * 4] ?? 0
    const y = s[i * 4 + 1] ?? 0
    const r = s[i * 4 + 3] ?? 0
    if (x < -40 || x > width + 40 || y < -20 || y > height + 20) return
    const node = g.nodes[i]!
    if (highlight && !highlight.has(node.id) && emphasis < 2) return
    // Fade with distance (NDC depth close to 1 = far).
    const far = Math.min(1, Math.max(0, (depth - 0.985) / 0.015))
    const alpha = emphasis >= 2 ? 1 : Math.max(0.18, 1 - far) * (emphasis === 1 ? 0.95 : 0.7)
    const px = emphasis >= 2 ? 13 : emphasis === 1 ? 12 : 11
    ctx.font = `${emphasis >= 2 ? 600 : 500} ${px}px Inter, ui-sans-serif, system-ui, sans-serif`
    const label = node.ghost ? `+ ${node.title}` : node.title
    const color = node.ghost ? GHOST_COLOR : c.colorMode === 'area' ? AREA_COLORS[node.area] : '#e8ecff'
    ctx.globalAlpha = alpha
    ctx.lineWidth = 3.5
    ctx.strokeStyle = 'rgba(4,5,13,0.85)'
    ctx.strokeText(label, x, y + r + 6)
    ctx.fillStyle = emphasis >= 2 ? '#ffffff' : color
    ctx.fillText(label, x, y + r + 6)
  }

  // Zoom-adaptive: anything drawn large enough gets a label.
  let extra = 0
  for (let i = 0; i < b.count && extra < 60; i++) {
    if (labelSet.has(i)) continue
    if ((s[i * 4 + 3] ?? 0) > 10) {
      draw(i, 0)
      extra++
    }
  }
  for (const i of labelSet) if (i !== selI && i !== hovI) draw(i, 1)
  if (hovI >= 0 && hovI !== selI) draw(hovI, 2)
  if (selI >= 0) draw(selI, 2)
  ctx.globalAlpha = 1
}
