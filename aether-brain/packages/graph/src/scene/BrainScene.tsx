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
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
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
import { BrainController, DEFAULT_FAR, DEFAULT_MAX_DISTANCE, cameraRange } from '../BrainController'
import { GALLERY_CHECK_MS, easeGrow, nearestStar, stepGrow } from '../gallery'
import type { LayoutEngine } from '../layout/LayoutEngine'
import {
  AREA_COLORS,
  GHOST_COLOR,
  IMAGE_COLOR,
  STAR_COLOR,
  SUN_COLOR,
  TODAY_COLOR,
  nodeBaseColor,
  nodeRadius,
  planetColor,
  tagColor,
  type PictureSize,
} from '../theme'
import {
  NEBULA_COLORS,
  createEdgeMaterial,
  createFieldMaterial,
  createHaloMaterial,
  createNebulaMaterial,
  createNodeMaterial,
  createRingMaterial,
  createStarMaterial,
} from './materials'
import { shiftTarget } from './follow'
import { todayLabel } from './labels'
import { ThumbLayer, thumbTargets, type ThumbTargets } from './thumbLayer'
import { ScreenLayer } from './screenLayer'
import { cardFade, thumbDrawnHalf, thumbHalf, thumbPickHit, THUMB_SCALE } from './thumbs'

const HOME_POS: [number, number, number] = [0, 150, 460]
/** Vertical field of view (degrees), and the tangent of half of it. */
const FOV = 55
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360)
const BG = '#04050d'

export interface BrainSceneProps {
  controller: BrainController
  /** Devicepixel cap; lower on integrated GPUs. */
  maxDpr?: number
  className?: string
}

/**
 * The thought-space. One InstancedMesh for neuron cores, one for halos, one
 * LineSegments for every synapse, one instanced LineSegments for every orbit
 * ring (system layout), one instanced billboard mesh for picture thumbnails
 * (image moons and the cards of a star gallery), a starfield, selective
 * bloom, a 2D label overlay and screen-space picking. Nothing here allocates
 * per frame.
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
        camera={{ fov: FOV, near: 1, far: DEFAULT_FAR, position: HOME_POS }}
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
    const here = new Vector3()
    const shift = { value: 0 }
    const cam = camera as PerspectiveCamera
    // Set here, not as a prop: `setRange` raises it for big scenes and a
    // re-render must not put the default back.
    c.maxDistance = DEFAULT_MAX_DISTANCE
    const applyShift = (smooth: boolean) => {
      const dist = c.distance
      const halfW = Math.tan((cam.fov * Math.PI) / 360) * dist * cam.aspect
      void c.setFocalOffset(-halfW * shift.value, 0, 0, smooth)
    }
    controller.registerCamera({
      setRange(distance) {
        const { far, maxDistance } = cameraRange(distance)
        c.maxDistance = maxDistance
        if (cam.far !== far) {
          cam.far = far
          cam.updateProjectionMatrix()
        }
      },
      flyTo(x, y, z, distance, smooth = true, minElevation) {
        c.getPosition(pos, true)
        c.getTarget(tgt, true)
        const dir = pos.sub(tgt)
        if (dir.lengthSq() < 1e-3) dir.set(0, 0.35, 1)
        dir.normalize()
        if (minElevation !== undefined && dir.y < Math.sin(minElevation)) {
          const h = Math.hypot(dir.x, dir.z)
          const k = h > 1e-6 ? Math.cos(minElevation) / h : 0
          dir.set(h > 1e-6 ? dir.x * k : 0, Math.sin(minElevation), h > 1e-6 ? dir.z * k : Math.cos(minElevation))
        }
        dir.multiplyScalar(distance)
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
      getPosition(out) {
        c.getPosition(here, true)
        out[0] = here.x
        out[1] = here.y
        out[2] = here.z
        return out
      },
      getTarget(out) {
        c.getTarget(here, true)
        out[0] = here.x
        out[1] = here.y
        out[2] = here.z
        return out
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
      dollySpeed={0.6}
      truckSpeed={1.4}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Backdrop: stars + nebula haze                                       */
/* ------------------------------------------------------------------ */

function Backdrop() {
  const camera = useThree((s) => s.camera)
  const sky = useMemo(() => new Group(), [])
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
    // The sky is infinitely far away: it travels with the camera (a solar
    // system can be far larger than the star shell).
    sky.position.copy(camera.position)
  })
  return (
    <primitive object={sky}>
      <primitive object={stars} />
      {nebulae.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </primitive>
  )
}

/* ------------------------------------------------------------------ */
/* The brain                                                          */
/* ------------------------------------------------------------------ */

/** Folder role codes per node (-1 for notes and ghosts). */
const ROLE_ROOT = 0
const ROLE_MOUNT = 1
const ROLE_PROJECT = 2
const ROLE_FOLDER = 3
const ROLE_CODES = { root: ROLE_ROOT, mount: ROLE_MOUNT, project: ROLE_PROJECT, folder: ROLE_FOLDER } as const

/** Segments of the unit circle every orbit ring is drawn from. */
const RING_SEGMENTS = 96

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
  /** Structural parent index per node (-1: none). */
  parentIdx: Int32Array
  /** Children per node (CSR over `childList`), for the selected node's system. */
  childStart: Int32Array
  childList: Int32Array
  /** Folder role code per node, -1 for notes and ghosts. */
  role: Int8Array
  /** Label text per node ('★ ' for project stars, ' +N' for collapsed folders). */
  labels: string[]
  /** Label color per node (depends on the color mode; set by recolor). */
  labelColors: string[]
  /** Root, mounts, project stars and the Today hub: always labelled. */
  landmarks: number[]
  /** 1 per landmark node. */
  landmark: Uint8Array
  /** 1 per edge that is a beam of the Today hub. */
  edgeBeam: Uint8Array
  /** Image nodes and which of them show their picture (see ThumbLayer). */
  thumbs: ThumbTargets
  /** Project stars: the camera is measured against them (star galleries). */
  stars: Int32Array
  /** Cards of the open star gallery (node indices), and per card 1 when it is in the graph for the gallery only. */
  cards: Int32Array
  cardOnly: Uint8Array
  /** 1 per node that is a gallery card. */
  isCard: Uint8Array
  /** Radius per node as the theme gives it (`radii` holds the drawn one: gallery cards grow from it). */
  baseRadii: Float32Array
  /** Orbit rings: one instanced LineSegments. */
  rings: LineSegments
  ringGeo: InstancedBufferGeometry
  ringCenter: InstancedBufferAttribute
  ringRadius: InstancedBufferAttribute
  ringQuat: InstancedBufferAttribute
  ringColor: InstancedBufferAttribute
  ringAlpha: InstancedBufferAttribute
  ringParent: Int32Array
  ringCount: number
  /** engine.ringsVersion the ring attributes were built from (-1: never). */
  ringsVersion: number
  ageOf: (n: GraphNode) => number
  dispose(): void
}

function buildBuffers(graph: GraphData, pictures: PictureSize): Buffers {
  const count = graph.nodes.length
  const sphere = new SphereGeometry(1, 16, 12)
  const plane = new PlaneGeometry(1, 1)
  const glow = new InstancedBufferAttribute(new Float32Array(count * 4), 4)
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
  const edgeBeam = new Uint8Array(edgeCount)
  graph.edges.forEach((e, i) => {
    edgeIdx[i * 2] = graph.index.get(e.from) ?? 0
    edgeIdx[i * 2 + 1] = graph.index.get(e.to) ?? 0
    if (e.kind === 'today') edgeBeam[i] = 1
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
  graph.nodes.forEach((n, i) => (radii[i] = nodeRadius(n, pictures)))
  const stars: number[] = []
  const cards: number[] = []
  const cardOnly: number[] = []
  const isCard = new Uint8Array(count)
  graph.nodes.forEach((n, i) => {
    if (n.folder?.role === 'project') stars.push(i)
    const card = n.image?.gallery
    if (!card) return
    cards.push(i)
    cardOnly.push(card.only ? 1 : 0)
    isCard[i] = 1
  })

  // A loop, not Math.min(...times): spreading more than about 125,000 numbers overflows the call stack.
  let minT = Infinity
  let maxT = -Infinity
  for (const n of graph.nodes) {
    if (n.created === null) continue
    if (n.created < minT) minT = n.created
    if (n.created > maxT) maxT = n.created
  }
  if (minT === Infinity) {
    minT = 0
    maxT = 1
  }
  const span = Math.max(1, maxT - minT)
  const ageOf = (n: GraphNode) => (n.created === null ? 0.9 : 1 - (n.created - minT) / span)

  const hubs = graph.nodes
    .map((n, i) => ({ i, d: n.ghost ? -1 : n.degree }))
    .sort((a, b) => b.d - a.d)
    .slice(0, 28)
    .map((x) => x.i)

  // Structure of the system layout: parents, children, roles, labels.
  const parentIdx = new Int32Array(count).fill(-1)
  const childStart = new Int32Array(count + 1)
  const role = new Int8Array(count).fill(-1)
  const labels: string[] = new Array<string>(count)
  // Note label colors follow the color mode (recolor); folders keep their body color.
  const labelColors: string[] = new Array<string>(count).fill('#e8ecff')
  const landmarks: number[] = []
  const landmark = new Uint8Array(count)
  graph.nodes.forEach((n, i) => {
    const p = n.parent === null ? -1 : (graph.index.get(n.parent) ?? -1)
    parentIdx[i] = p
    if (p >= 0) childStart[p + 1] = childStart[p + 1]! + 1
    const f = n.folder
    if (f) {
      role[i] = ROLE_CODES[f.role] ?? ROLE_FOLDER
      if (f.role !== 'folder') landmarks.push(i)
      labelColors[i] = f.role === 'folder' ? planetColor(f.path) : f.role === 'project' ? STAR_COLOR : SUN_COLOR
    }
    let label = n.ghost ? `+ ${n.title}` : n.title
    if (f?.role === 'project') label = `★ ${label}`
    if (f && f.hiddenFolders > 0) label = `${label} +${f.hiddenFolders}`
    if (n.today) {
      landmarks.push(i)
      labelColors[i] = TODAY_COLOR
      label = todayLabel(n.today.total, n.today.overdue)
    } else if (n.image) {
      labelColors[i] = IMAGE_COLOR
    }
    labels[i] = label
  })
  for (const i of landmarks) landmark[i] = 1
  for (let i = 0; i < count; i++) childStart[i + 1] = childStart[i + 1]! + childStart[i]!
  const childList = new Int32Array(Math.max(1, childStart[count]!))
  const fill = childStart.slice(0, count)
  for (let i = 0; i < count; i++) {
    const p = parentIdx[i]!
    if (p < 0) continue
    childList[fill[p]!] = i
    fill[p] = fill[p]! + 1
  }

  // Orbit rings: a unit circle in XZ, instanced once per ring. Every ring has
  // at least one child on it, so the node count bounds the ring count.
  const circle = new Float32Array(RING_SEGMENTS * 6)
  for (let k = 0; k < RING_SEGMENTS; k++) {
    const a0 = (k / RING_SEGMENTS) * Math.PI * 2
    const a1 = ((k + 1) / RING_SEGMENTS) * Math.PI * 2
    circle.set([Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1)], k * 6)
  }
  const ringCap = Math.max(1, count)
  const ringGeo = new InstancedBufferGeometry()
  ringGeo.setAttribute('position', new Float32BufferAttribute(circle, 3))
  const ringAttr = (size: number, dynamic: boolean) => {
    const a = new InstancedBufferAttribute(new Float32Array(ringCap * size), size)
    if (dynamic) a.setUsage(DynamicDrawUsage)
    return a
  }
  const ringCenter = ringAttr(3, true)
  const ringRadius = ringAttr(1, false)
  const ringQuat = ringAttr(4, false)
  const ringColor = ringAttr(3, false)
  const ringAlpha = ringAttr(1, true)
  ringGeo.setAttribute('iCenter', ringCenter)
  ringGeo.setAttribute('iRadius', ringRadius)
  ringGeo.setAttribute('iQuat', ringQuat)
  ringGeo.setAttribute('iColor', ringColor)
  ringGeo.setAttribute('iAlpha', ringAlpha)
  ringGeo.instanceCount = 0
  const rings = new LineSegments(ringGeo, createRingMaterial())
  rings.frustumCulled = false
  rings.visible = false
  rings.renderOrder = 0

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
    parentIdx,
    childStart,
    childList,
    role,
    labels,
    labelColors,
    landmarks,
    landmark,
    edgeBeam,
    thumbs: thumbTargets(graph),
    stars: Int32Array.from(stars),
    cards: Int32Array.from(cards),
    cardOnly: Uint8Array.from(cardOnly),
    isCard,
    baseRadii: new Float32Array(radii),
    rings,
    ringGeo,
    ringCenter,
    ringRadius,
    ringQuat,
    ringColor,
    ringAlpha,
    ringParent: new Int32Array(ringCap),
    ringCount: 0,
    ringsVersion: -1,
    ageOf,
    dispose() {
      sphere.dispose()
      plane.dispose()
      eg.dispose()
      ringGeo.dispose()
      ;(rings.material as { dispose(): void }).dispose()
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
  // A new picture size rebuilds the graph (the store), so the graph is the key.
  const buffers = useMemo(() => (graph ? buildBuffers(graph, controller.pictureSize) : null), [graph, controller])
  useEffect(() => () => buffers?.dispose(), [buffers])
  // Pictures outlive graphs (they are kept by path), so the thumbnail layer lives as long as the scene.
  const thumbs = useMemo(() => new ThumbLayer(), [])
  useEffect(() => () => thumbs.dispose(), [thumbs])
  // The live screen above a star (desktop: Concept Forge), drawn while the camera is close to it.
  const screenLayer = useMemo(() => new ScreenLayer(), [])
  useEffect(() => () => screenLayer.dispose(), [screenLayer])

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
    /** Buffers the visual state was last computed for (new buffers force a recolor). */
    buffers: null as Buffers | null,
    /** Camera follow: node being followed and where it was on the last frame. */
    followIndex: -1,
    followPos: new Vector3(),
    followTarget: new Vector3(),
    followCur: new Vector3(),
    /** Layout frame and buffers the follow step last ran for. */
    followFrame: -1,
    followBuffers: null as Buffers | null,
    /** Star gallery: the star whose cards are drawn, their growth (linear 0..1), what their sizes were last set from. */
    galleryStar: null as NoteId | null,
    grow: 0,
    cardBuffers: null as Buffers | null,
    cardRings: -1,
    /** When the camera was last measured against the stars. */
    lastNearCheck: -Infinity,
    /** A press that started on the star screen (a click there opens its app), and whether the pointer is over it. */
    screenPress: null as null | { x: number; y: number },
    overScreen: false,
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
      // The star screen is in front of what it covers: a press on it is the screen's.
      if (screenLayer.hit(x, y, size.width, size.height, camera)) {
        st.screenPress = { x, y }
        return
      }
      const i = pick(x, y)
      if (i < 0) return
      st.drag = { index: i, id: buffers.graph.nodes[i]!.id, sx: x, sy: y, moved: false }
      controller.camera?.setEnabled(false)
    }
    const onUp = () => {
      const press = st.screenPress
      st.screenPress = null
      // A click on the screen (not a drag that orbits the camera) opens its app.
      if (press && Math.hypot(st.pointer.x - press.x, st.pointer.y - press.y) < 6) controller.activateScreen()
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
      if (screenLayer.hit(e.clientX - r.left, e.clientY - r.top, size.width, size.height, camera)) return
      const i = pick(e.clientX - r.left, e.clientY - r.top)
      if (i >= 0) controller.events.onOpen?.(buffers.graph.nodes[i]!.id)
    }
    const onClickEmpty = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      if (screenLayer.hit(e.clientX - r.left, e.clientY - r.top, size.width, size.height, camera)) return
      if (pick(e.clientX - r.left, e.clientY - r.top) < 0 && controller.selected) controller.events.onSelect?.(null)
    }
    const pick = (x: number, y: number): number => {
      const s = buffers.screen
      const selI = controller.selected ? (buffers.graph.index.get(controller.selected) ?? -1) : -1
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < buffers.count; i++) {
        const sx = s[i * 4] ?? 0
        const sy = s[i * 4 + 1] ?? 0
        const depth = s[i * 4 + 2] ?? 2
        if (depth > 1 || depth < -1) continue
        if (hits(buffers, i, sx - x, sy - y, selI, st.hovered, size.height) && depth < bestD) {
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
    const rel = new Vector3()
    const dragTo = (index: number, id: NoteId, x: number, y: number) => {
      ndc.set((x / size.width) * 2 - 1, -(y / size.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const p = controller.engine.positions
      plane.set(p[index * 3] ?? 0, p[index * 3 + 1] ?? 0, p[index * 3 + 2] ?? 0)
      camera.getWorldDirection(nrm)
      const denom = nrm.dot(ray.ray.direction)
      if (Math.abs(denom) < 1e-6) return
      const t = rel.copy(plane).sub(ray.ray.origin).dot(nrm) / denom
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
  }, [buffers, gl, camera, size, controller, screenLayer])

  /* ---- camera follow ---- */
  // While planets orbit, keep the selected node where it is on screen by
  // moving the camera target with it, unless the user has looked away from it
  // (reset view, panned to another system). Runs before drei's CameraControls
  // update (priority -1), so the camera moves in the same frame as the node.
  useFrame(() => {
    const st = state.current
    const eng = controller.engine
    if (!buffers || eng.frame === st.followFrame) return
    st.followFrame = eng.frame
    if (st.followBuffers !== buffers) {
      st.followBuffers = buffers
      st.followIndex = -1
    }
    // The controller can be a graph ahead of the buffers for a moment: indices would not match.
    if (controller.graph !== buffers.graph) return
    const pos = eng.positions
    const selI = controller.selected ? (buffers.graph.index.get(controller.selected) ?? -1) : -1
    const on = controller.follow && controller.motion && controller.layoutMode === 'system'
    if (!on || selI < 0 || selI * 3 + 2 >= pos.length || st.drag || !controls) {
      st.followIndex = -1
      return
    }
    const x = pos[selI * 3]!
    const y = pos[selI * 3 + 1]!
    const z = pos[selI * 3 + 2]!
    if (st.followIndex === selI) {
      const dx = x - st.followPos.x
      const dy = y - st.followPos.y
      const dz = z - st.followPos.z
      const t = controls.getTarget(st.followTarget, true)
      const near = Math.hypot(t.x - st.followPos.x, t.y - st.followPos.y, t.z - st.followPos.z) < Math.max(40, controls.distance * 0.6)
      if (near && (dx !== 0 || dy !== 0 || dz !== 0)) shiftTarget(controls, dx, dy, dz, st.followCur, st.followTarget)
    }
    st.followIndex = selI
    st.followPos.set(x, y, z)
  }, -2)

  /* ---- per-frame: positions, visual state, projection, labels ---- */
  const m4 = useMemo(() => new Matrix4(), [])
  const v3 = useMemo(() => new Vector3(), [])
  const camPos = useMemo(() => new Vector3(), [])
  const camEnd = useMemo(() => new Vector3(), [])
  const lookEnd = useMemo(() => new Vector3(), [])

  useFrame((_, dt) => {
    if (!buffers) return
    const st = state.current
    st.time += dt
    const eng = controller.engine
    const g = buffers.graph
    const n = buffers.count
    const pos = eng.positions
    if (pos.length < n * 3) return

    ;(buffers.nodes.material as ShaderMaterial).uniforms['uTime']!.value = st.time
    ;(buffers.halos.material as ShaderMaterial).uniforms['uTime']!.value = st.time
    ;(buffers.edges.material as ShaderMaterial).uniforms['uTime']!.value = st.time
    ;(buffers.field.material as ShaderMaterial).uniforms['uTime']!.value = st.time

    // Hover pick each frame (cheap; avoids doing it per pointermove event). The star screen covers what is behind it.
    let hoveredIndex = -1
    const overScreen = st.pointerInside && !st.drag && screenLayer.hit(st.pointer.x, st.pointer.y, size.width, size.height, camera)
    if (st.pointerInside && !st.drag && !overScreen) {
      const s = buffers.screen
      const px = st.pointer.x
      const py = st.pointer.y
      const sel = controller.selected ? (g.index.get(controller.selected) ?? -1) : -1
      let bestD = Infinity
      for (let i = 0; i < n; i++) {
        const depth = s[i * 4 + 2] ?? 2
        if (depth > 1 || depth < -1) continue
        if (hits(buffers, i, (s[i * 4] ?? 0) - px, (s[i * 4 + 1] ?? 0) - py, sel, st.hovered, size.height) && depth < bestD) {
          bestD = depth
          hoveredIndex = i
        }
      }
    }
    if (hoveredIndex !== st.hovered || overScreen !== st.overScreen) {
      const changed = hoveredIndex !== st.hovered
      st.hovered = hoveredIndex
      st.overScreen = overScreen
      const id = hoveredIndex >= 0 ? (g.nodes[hoveredIndex]?.id ?? null) : null
      if (changed) {
        controller.setHovered(id)
        controller.events.onHover?.(id)
      }
      gl.domElement.style.cursor = id || overScreen ? 'pointer' : ''
    }

    const fresh = st.buffers !== buffers
    if (fresh) st.buffers = buffers
    const versionChanged = fresh || controller.version !== st.lastVersion
    const positionsChanged = fresh || eng.frame !== st.lastFrame
    const ringsChanged = eng.ringsVersion !== buffers.ringsVersion
    st.lastVersion = controller.version
    st.lastFrame = eng.frame

    if (versionChanged) recolor(buffers, controller, st.neighbors, st.labelSet)
    if (ringsChanged) {
      syncRings(buffers, eng.rings)
      buffers.ringsVersion = eng.ringsVersion
    }
    if (ringsChanged || versionChanged) styleRings(buffers, controller)
    buffers.rings.visible = controller.layoutMode === 'system' && buffers.ringCount > 0

    const selI = controller.selected ? (g.index.get(controller.selected) ?? -1) : -1
    const hovI = st.hovered

    // Star gallery cards grow out of their star, and shrink when it folds.
    const cardsChanged = sizeCards(buffers, controller, eng, st, dt)

    // Pictures: pick, load and place them; a change in who shows one reshapes the cores below.
    const now = performance.now()
    const thumbsChanged = thumbs.update(buffers, controller, pos, selI, hovI, size.width, size.height, now)
    screenLayer.update(controller, g, pos, eng.extents, camera, now, dt)

    if (positionsChanged || versionChanged || thumbsChanged || cardsChanged) {
      // Instance matrices for cores + halos. A node showing its picture keeps
      // a small core behind it and no halo: the picture is the body. A gallery
      // card still waiting for its picture is a picture moon's pale body.
      const shown = buffers.thumbs.shown
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3] ?? 0
        const y = pos[i * 3 + 1] ?? 0
        const z = pos[i * 3 + 2] ?? 0
        let r = buffers.radii[i] ?? 1
        if (buffers.isCard[i] === 1 && shown[i] !== 1) r = Math.min(r, buffers.baseRadii[i] ?? 1)
        if (i === selI) r *= 1.35
        else if (i === hovI) r *= 1.2
        const pictured = shown[i] === 1
        // A gallery card is all picture: no core to show when it fades as the camera passes.
        const core = pictured ? (buffers.isCard[i] === 1 ? 0 : r * THUMB_CORE) : r
        m4.makeScale(core, core, core)
        m4.setPosition(x, y, z)
        buffers.nodes.setMatrixAt(i, m4)
        const h = pictured ? 0 : r * 3.2
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
    if ((positionsChanged || ringsChanged || versionChanged) && buffers.rings.visible) placeRings(buffers, pos)

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

    drawLabels(overlayRef.current, buffers, controller, st.labelSet, hovI, selI, size.width, size.height, screenLayer)

    // Star galleries: which project star is the camera close to? Measured where the camera is going
    // (the end of a flight), so flying past a star counts for nothing. Last in the frame: the answer
    // can rebuild the graph (a gallery opening), and this frame's buffers are done with by now.
    // The star the controller holds (opened with Shift+G, open, else last found) keeps its place until
    // the camera is clearly closer to another one; the answer goes in whenever the controller's differs.
    if (controller.layoutMode === 'system' && now - st.lastNearCheck >= GALLERY_CHECK_MS && eng.extents.length === n && controller.graph === g) {
      st.lastNearCheck = now
      if (controls) {
        controls.getPosition(camEnd, true)
        controls.getTarget(lookEnd, true)
      } else {
        camEnd.copy(camPos)
        lookEnd.copy(camPos)
      }
      const held = controller.galleryHeld
      const current = held === null ? -1 : (g.index.get(held) ?? -1)
      const k = nearestStar(buffers.stars, pos, eng.extents, camEnd.x, camEnd.y, camEnd.z, lookEnd.x, lookEnd.y, lookEnd.z, current)
      const id = k >= 0 ? (g.nodes[k]?.id ?? null) : null
      if (id !== controller.nearId) controller.nearStar(id)
    }
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
      <primitive object={buffers.rings} />
      <primitive object={buffers.edges} />
      <primitive object={buffers.nodes} />
      <primitive object={buffers.halos} />
      <primitive object={buffers.field} />
      <primitive object={thumbs.mesh} />
      <primitive object={screenLayer.group} />
    </>
  )
}

/**
 * True when the pointer, (dx, dy) px from node `i`'s projected centre, hits
 * it: its body, or while it shows one, its picture as drawn (grown when
 * hovered or selected).
 */
function hits(b: Buffers, i: number, dx: number, dy: number, selI: number, hovI: number, viewHeight: number): boolean {
  const picture = b.thumbs.shown[i] === 1
  if (b.isCard[i] === 1) {
    // A gallery card still growing out of its star (or folding into it) is not there yet,
    // nor is one the camera is passing (faded out).
    if (!((b.radii[i] ?? 0) > 0.25)) return false
    if (picture && i !== selI && cardFade((b.screen[i * 4 + 3] ?? 0) * THUMB_SCALE, viewHeight) < 0.5) return false
  }
  const px = bodyPx(b, i)
  return thumbPickHit(dx, dy, px, picture, picture ? thumbDrawnHalf(thumbHalf(i, selI, hovI), px, viewHeight, TAN_HALF_FOV) : 1)
}

/**
 * Projected radius (px) node `i` is picked and labelled with: a gallery card
 * still waiting for its picture is drawn as a picture moon's body, not at its
 * card size.
 */
function bodyPx(b: Buffers, i: number): number {
  const px = b.screen[i * 4 + 3] ?? 0
  if (b.isCard[i] !== 1 || b.thumbs.shown[i] === 1) return px
  const r = b.radii[i] ?? 0
  return r > 0 ? px * Math.min(1, (b.baseRadii[i] ?? r) / r) : px
}

/* ------------------------------------------------------------------ */
/* Visual state                                                       */
/* ------------------------------------------------------------------ */

const IDLE_GLOW = 1.35
const NEIGHBOR_GLOW = 1.5
const HOVER_GLOW = 1.7
const SELECTED_GLOW = 1.9
/** Folders by role: suns (root, mounts) and project stars bloom; planets read as solid bodies. */
const SUN_GLOW = 2.2
const STAR_GLOW = 2.4
const PLANET_GLOW = 0.95
/** The Today hub outshines the stars (and breathes: the core pulses above glow 1.5). */
const TODAY_GLOW = 2.6
/** Picture moons are solid and stay under the bloom threshold: their pale color would smear. */
const IMAGE_GLOW = 0.75
/** Core radius of a node while its picture is drawn, relative to its radius (hidden behind the picture). */
const THUMB_CORE = 0.35
/** Link edges fade in the system layout: structure is shown by the orbits there. */
const EDGE_BASE = 0.36
const EDGE_BASE_SYSTEM = 0.12
/**
 * Highlight weight of the Today hub's beams in the system layout while they
 * are in focus: the faint base there would hide them, and they should read
 * as light (a highlighted link is weight 1).
 */
const BEAM_HI_SYSTEM = 1.6
const RING_ALPHA = 0.13
const RING_ALPHA_DIMMED = 0.07
const RING_ALPHA_SIBLINGS = 0.3
const RING_ALPHA_SELECTED = 0.6

function recolor(b: Buffers, c: BrainController, neighbors: Set<number>, labelSet: Set<number>): void {
  const g = b.graph
  const n = b.count
  const colors = b.color.array as Float32Array
  const glow = b.glow.array as Float32Array
  const base = b.baseColors
  const selI = c.selected ? (g.index.get(c.selected) ?? -1) : -1
  const hovI = c.hovered ? (g.index.get(c.hovered) ?? -1) : -1
  const focusI = selI >= 0 ? selI : hovI
  const system = c.layoutMode === 'system'

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
    if (system) {
      // The focus's own system: what it orbits and everything orbiting it.
      const p = b.parentIdx[focusI]!
      if (p >= 0) neighbors.add(p)
      for (let k = b.childStart[focusI]!; k < b.childStart[focusI + 1]!; k++) neighbors.add(b.childList[k]!)
      // A star with its gallery open: every card is its own (moons among them orbit its planets).
      if (g.gallery && g.nodes[focusI]!.id === g.gallery.star) for (const k of b.cards) neighbors.add(k)
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
    const role = b.role[i]!
    let gl = IDLE_GLOW
    let solid = 0
    if (node.kind === 'today') {
      gl = i === selI ? TODAY_GLOW + 0.4 : i === hovI ? TODAY_GLOW + 0.2 : TODAY_GLOW
    } else if (node.kind === 'image') {
      solid = 1
      gl = i === selI ? IMAGE_GLOW + 0.25 : i === hovI ? IMAGE_GLOW + 0.15 : neighbors.has(i) ? IMAGE_GLOW + 0.07 : IMAGE_GLOW
    } else if (role === ROLE_FOLDER) {
      solid = 1
      gl = i === selI ? 1.2 : i === hovI ? 1.1 : neighbors.has(i) ? 1.02 : PLANET_GLOW
    } else if (role >= 0) {
      const star = role === ROLE_PROJECT ? STAR_GLOW : SUN_GLOW
      gl = i === selI ? star + 0.4 : i === hovI ? star + 0.2 : star
    } else {
      if (i === selI) gl = SELECTED_GLOW
      else if (i === hovI) gl = HOVER_GLOW
      else if (neighbors.has(i)) gl = NEIGHBOR_GLOW
      if (node.ghost) gl *= 0.55
      b.labelColors[i] = node.ghost ? GHOST_COLOR : c.colorMode === 'area' ? AREA_COLORS[node.area] : '#e8ecff'
    }
    let dim = 1
    if (hasHighlight && !highlight.has(node.id)) dim = 0.12
    else if (focusI >= 0 && i !== focusI && !neighbors.has(i)) dim = selI >= 0 ? 0.32 : 0.6
    colors[i * 3] = col.r
    colors[i * 3 + 1] = col.g
    colors[i * 3 + 2] = col.b
    glow[i * 4] = gl
    glow[i * 4 + 1] = dim
    glow[i * 4 + 2] = (i * 0.618) % 6.283
    glow[i * 4 + 3] = solid
  }
  b.color.needsUpdate = true
  b.glow.needsUpdate = true
  ;(b.edges.material as ShaderMaterial).uniforms['uBase']!.value = system ? EDGE_BASE_SYSTEM : EDGE_BASE

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
    if (focusI >= 0 && (a === focusI || z === focusI)) hi = system && b.edgeBeam[e] === 1 ? BEAM_HI_SYSTEM : 1
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
  for (const i of neighbors) if (labelSet.size < 70 && b.isCard[i] !== 1) labelSet.add(i)
  if (hasHighlight && highlight.size <= 80) {
    for (const id of highlight) {
      const i = g.index.get(id)
      if (i !== undefined) labelSet.add(i)
    }
  } else if (c.hubLabels) {
    for (const i of b.hubs) labelSet.add(i)
  }
}

/**
 * Size the gallery cards: from their body (a moon's radius, or nothing for a
 * card that is only in the gallery) up to the size the layout gives them,
 * as the gallery grows open or folds. Returns true when any radius changed.
 */
function sizeCards(
  b: Buffers,
  c: BrainController,
  eng: LayoutEngine,
  st: { galleryStar: NoteId | null; grow: number; cardBuffers: Buffers | null; cardRings: number },
  dt: number,
): boolean {
  const star = b.cards.length > 0 ? (b.graph.gallery?.star ?? null) : null
  // A new gallery grows from nothing; a rebuild of the same one keeps its size.
  if (star !== st.galleryStar) {
    st.galleryStar = star
    st.grow = 0
  }
  if (star === null) return false
  const before = st.grow
  st.grow = stepGrow(st.grow, c.galleryFold >= 0, dt * 1000)
  if (st.grow === before && st.cardBuffers === b && st.cardRings === eng.ringsVersion) return false
  st.cardBuffers = b
  st.cardRings = eng.ringsVersion
  const e = easeGrow(st.grow)
  const sizes = eng.cards.length === b.count ? eng.cards : null
  for (let k = 0; k < b.cards.length; k++) {
    const i = b.cards[k]!
    const body = b.cardOnly[k] === 1 ? 0 : b.baseRadii[i]!
    const full = sizes && sizes[i]! > 0 ? sizes[i]! : b.baseRadii[i]!
    b.radii[i] = body + (full - body) * e
  }
  return true
}

/** Copy the worker's ring buffer (6 floats per ring) into the instance attributes. */
function syncRings(b: Buffers, rings: Float32Array): void {
  const radius = b.ringRadius.array as Float32Array
  const quat = b.ringQuat.array as Float32Array
  const total = Math.floor(rings.length / 6)
  let k = 0
  for (let r = 0; r < total && k < b.ringParent.length; r++) {
    const p = rings[r * 6] ?? -1
    if (!(p >= 0 && p < b.count)) continue
    b.ringParent[k] = p
    radius[k] = rings[r * 6 + 1] ?? 0
    quat[k * 4] = rings[r * 6 + 2] ?? 0
    quat[k * 4 + 1] = rings[r * 6 + 3] ?? 0
    quat[k * 4 + 2] = rings[r * 6 + 4] ?? 0
    quat[k * 4 + 3] = rings[r * 6 + 5] ?? 1
    k++
  }
  b.ringCount = k
  b.ringGeo.instanceCount = k
  b.ringRadius.needsUpdate = true
  b.ringQuat.needsUpdate = true
}

/** Ring tint (the parent's color, lifted toward white) and alpha: the selected node's system is brighter. */
function styleRings(b: Buffers, c: BrainController): void {
  const selI = c.selected ? (b.graph.index.get(c.selected) ?? -1) : -1
  const selParent = selI >= 0 ? b.parentIdx[selI]! : -1
  const color = b.ringColor.array as Float32Array
  const alpha = b.ringAlpha.array as Float32Array
  const base = b.baseColors
  for (let k = 0; k < b.ringCount; k++) {
    const p = b.ringParent[k]!
    let a = RING_ALPHA
    if (selI >= 0) a = p === selI ? RING_ALPHA_SELECTED : p === selParent ? RING_ALPHA_SIBLINGS : RING_ALPHA_DIMMED
    alpha[k] = a
    color[k * 3] = 0.45 + 0.55 * (base[p * 3] ?? 1)
    color[k * 3 + 1] = 0.45 + 0.55 * (base[p * 3 + 1] ?? 1)
    color[k * 3 + 2] = 0.45 + 0.55 * (base[p * 3 + 2] ?? 1)
  }
  b.ringColor.needsUpdate = true
  b.ringAlpha.needsUpdate = true
}

/** Centre every ring on its parent's live position (only the used range is uploaded). */
function placeRings(b: Buffers, pos: Float32Array): void {
  const center = b.ringCenter.array as Float32Array
  for (let k = 0; k < b.ringCount; k++) {
    const p = b.ringParent[k]!
    center[k * 3] = pos[p * 3] ?? 0
    center[k * 3 + 1] = pos[p * 3 + 1] ?? 0
    center[k * 3 + 2] = pos[p * 3 + 2] ?? 0
  }
  b.ringCenter.clearUpdateRanges()
  b.ringCenter.addUpdateRange(0, b.ringCount * 3)
  b.ringCenter.needsUpdate = true
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

const LABEL_FONTS = [
  '500 11px Inter, ui-sans-serif, system-ui, sans-serif',
  '500 12px Inter, ui-sans-serif, system-ui, sans-serif',
  '600 13px Inter, ui-sans-serif, system-ui, sans-serif',
] as const
/** Screen radius (px) above which a node gets a label: planets earlier than notes. */
const LABEL_MIN_PX = 10
const PLANET_LABEL_MIN_PX = 6
const ZOOM_LABELS = 60

function drawLabels(
  canvas: HTMLCanvasElement | null,
  b: Buffers,
  c: BrainController,
  labelSet: Set<number>,
  hovI: number,
  selI: number,
  width: number,
  height: number,
  screen: ScreenLayer,
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

  const shown = b.thumbs.shown
  /** emphasis: 0 zoom-adaptive, 1 candidate, 2 hovered/selected. `always`: landmarks (root, mounts, project stars, the Today hub). */
  const draw = (i: number, emphasis: 0 | 1 | 2, always = false) => {
    const depth = s[i * 4 + 2] ?? 2
    if (depth > 1 || depth < -1) return
    const x = s[i * 4] ?? 0
    const y = s[i * 4 + 1] ?? 0
    // Below the picture when the node shows one (it is wider than the core, and grows when hovered or selected).
    const px = bodyPx(b, i)
    const r = shown[i] === 1 ? px * (thumbDrawnHalf(thumbHalf(i, selI, hovI), px, height, TAN_HALF_FOV) + 0.1) : px
    if (x < -40 || x > width + 40 || y < -20 || y > height + 20) return
    // Behind a star's live screen: the app is in front of it.
    if (screen.covers(x, y, depth, width, height)) return
    const node = g.nodes[i]!
    const filtered = highlight !== null && !highlight.has(node.id) && emphasis < 2
    if (filtered && !always) return
    // Fade with distance (NDC depth close to 1 = far).
    const far = Math.min(1, Math.max(0, (depth - 0.985) / 0.015))
    let alpha = emphasis >= 2 ? 1 : Math.max(always ? 0.6 : 0.18, 1 - far) * (emphasis === 1 ? 0.95 : 0.7)
    if (filtered) alpha *= 0.45
    const label = b.labels[i] ?? node.title
    ctx.font = LABEL_FONTS[emphasis]
    ctx.globalAlpha = alpha
    ctx.lineWidth = 3.5
    ctx.strokeStyle = 'rgba(4,5,13,0.85)'
    ctx.strokeText(label, x, y + r + 6)
    ctx.fillStyle = emphasis >= 2 ? '#ffffff' : (b.labelColors[i] ?? '#e8ecff')
    ctx.fillText(label, x, y + r + 6)
  }

  // Zoom-adaptive: anything drawn large enough gets a label (planets sooner).
  let notes = 0
  let planets = 0
  for (let i = 0; i < b.count; i++) {
    if (labelSet.has(i) || i === selI || i === hovI) continue
    if (b.landmark[i] === 1) continue // landmarks are drawn below
    if (b.isCard[i] === 1) continue // a gallery is pictures: their names show on hover
    const role = b.role[i]!
    const px = s[i * 4 + 3] ?? 0
    if (role === ROLE_FOLDER) {
      if (px > PLANET_LABEL_MIN_PX && planets < ZOOM_LABELS) {
        draw(i, 0)
        planets++
      }
    } else if (px > LABEL_MIN_PX && notes < ZOOM_LABELS) {
      draw(i, 0)
      notes++
    }
  }
  for (const i of b.landmarks) if (!labelSet.has(i) && i !== selI && i !== hovI) draw(i, 1, true)
  for (const i of labelSet) if (i !== selI && i !== hovI && b.isCard[i] !== 1) draw(i, 1, b.landmark[i] === 1)
  if (hovI >= 0 && hovI !== selI) draw(hovI, 2)
  if (selI >= 0) draw(selI, 2)
  ctx.globalAlpha = 1
}
