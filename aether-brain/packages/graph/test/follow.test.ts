import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PerspectiveCamera, Vector3 } from 'three'
import { shiftTarget, type FollowControls } from '../src/scene/follow'

/** The real camera-controls (a dependency of drei), with the bits of it these tests look at. */
interface Controls extends FollowControls {
  setLookAt(px: number, py: number, pz: number, tx: number, ty: number, tz: number, smooth?: boolean): Promise<void>
  update(delta: number): boolean
  _listeners: Record<string, unknown[] | undefined>
}
type ControlsClass = { new (camera: PerspectiveCamera): Controls; install(libs: { THREE: unknown }): void }

function createControls(): { controls: Controls; camera: PerspectiveCamera } {
  // camera-controls allocates a DOMRect for pointer math; node has none.
  const g = globalThis as { DOMRect?: unknown }
  g.DOMRect ??= class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
  }
  const local = createRequire(import.meta.url)
  const mod = createRequire(local.resolve('@react-three/drei'))('camera-controls') as ControlsClass | { default: ControlsClass }
  const CameraControls = 'default' in mod ? mod.default : mod
  CameraControls.install({ THREE })
  const camera = new PerspectiveCamera(55, 1, 1, 12000)
  return { controls: new CameraControls(camera), camera }
}

/** A planet orbiting the origin at radius 40 (0.9/√40 rad/s, as in the system layout). */
function planetAt(t: number, out: Vector3): Vector3 {
  const a = (0.9 / Math.sqrt(40)) * t
  return out.set(Math.cos(a) * 40, 0, Math.sin(a) * 40)
}

describe('camera follow', () => {
  it('tracks an orbiting node through a flyTo without piling up rest listeners', () => {
    const { controls, camera } = createControls()
    controls.setLookAt(0, 150, 460, 0, 0, 0, false)
    controls.update(1 / 60)
    const node = planetAt(0, new Vector3())
    // Select + fly to the planet: a smooth transition starts.
    void controls.setLookAt(node.x, node.y + 30, node.z + 60, node.x, node.y, node.z, true)
    const last = node.clone()
    const cur = new Vector3()
    const end = new Vector3()
    const next = new Vector3()
    // 20 s at 60 fps; the layout worker posts every other frame (~30 fps).
    for (let f = 1; f <= 1200; f++) {
      if (f % 2 === 0) {
        planetAt(f / 60, next)
        shiftTarget(controls, next.x - last.x, next.y - last.y, next.z - last.z, cur, end)
        last.copy(next)
      }
      controls.update(1 / 60)
    }
    // Every transition has come to rest: nothing is left waiting.
    expect(controls._listeners['rest']?.length ?? 0).toBe(0)
    // The camera looks exactly at the planet, from where the flyTo put it.
    controls.getTarget(cur, false)
    expect(cur.distanceTo(last)).toBeLessThan(1e-3)
    const offset = camera.position.clone().sub(cur)
    expect(offset.distanceTo(new Vector3(0, 30, 60))).toBeLessThan(1e-2)
  })

  it('keeps a running transition going to its goal, shifted by the node movement', () => {
    const { controls } = createControls()
    controls.setLookAt(0, 0, 100, 0, 0, 0, false)
    controls.update(1 / 60)
    void controls.moveTo(50, 0, 0, true)
    controls.update(1 / 60)
    const cur = new Vector3()
    const end = new Vector3()
    const before = controls.getTarget(new Vector3(), false).clone()
    shiftTarget(controls, 0, 0, 5, cur, end)
    // The current point moved rigidly; the goal moved by the same amount.
    expect(controls.getTarget(new Vector3(), false).distanceTo(before.clone().add(new Vector3(0, 0, 5)))).toBeLessThan(1e-6)
    expect(controls.getTarget(new Vector3(), true).distanceTo(new Vector3(50, 0, 5))).toBeLessThan(1e-6)
    for (let f = 0; f < 600; f++) controls.update(1 / 60)
    expect(controls.getTarget(new Vector3(), false).distanceTo(new Vector3(50, 0, 5))).toBeLessThan(1e-3)
  })
})
