import { describe, expect, it, vi } from 'vitest'
import { BrainController, type ScreenHost } from '../src/BrainController'
import { SCREEN_DEFAULT_ASPECT, SCREEN_GAP, SCREEN_MIN_EXTENT, SCREEN_WIDTH, screenFade, screenPlacement } from '../src/screen'

describe('star screen placement', () => {
  it('sits above its star along the camera’s up direction, its lower edge a gap above the star', () => {
    const p = screenPlacement(10, 20, 30, 100, 0.5, 0, 1, 0, 1)
    expect(p.width).toBeCloseTo(100 * SCREEN_WIDTH)
    expect(p.height).toBeCloseTo(100 * SCREEN_WIDTH * 0.5)
    expect(p.x).toBeCloseTo(10)
    expect(p.z).toBeCloseTo(30)
    // Centre: gap + half the height above the star.
    expect(p.y).toBeCloseTo(20 + 100 * SCREEN_GAP + p.height / 2)
  })

  it('follows a tilted camera’s up direction (any length)', () => {
    const p = screenPlacement(0, 0, 0, 100, 0.5, 0, 0, 3, 1)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
    expect(p.z).toBeCloseTo(100 * SCREEN_GAP + p.height / 2)
  })

  it('grows out of the star: a point at 0, half the size half way', () => {
    const none = screenPlacement(5, 5, 5, 100, 0.5, 0, 1, 0, 0)
    expect(none).toMatchObject({ x: 5, y: 5, z: 5, width: 0, height: 0 })
    const half = screenPlacement(0, 0, 0, 100, 0.5, 0, 1, 0, 0.5)
    const full = screenPlacement(0, 0, 0, 100, 0.5, 0, 1, 0, 1)
    expect(half.width).toBeCloseTo(full.width / 2)
    expect(half.y).toBeCloseTo(full.y / 2)
  })

  it('keeps a readable size around a tiny star and a sane shape for odd frames', () => {
    expect(screenPlacement(0, 0, 0, 2, 0.5, 0, 1, 0, 1).width).toBeCloseTo(SCREEN_MIN_EXTENT * SCREEN_WIDTH)
    expect(screenPlacement(0, 0, 0, NaN, 0.5, 0, 1, 0, 1).width).toBeCloseTo(SCREEN_MIN_EXTENT * SCREEN_WIDTH)
    const odd = screenPlacement(0, 0, 0, 100, 0, 0, 1, 0, 1)
    expect(odd.height / odd.width).toBeCloseTo(SCREEN_DEFAULT_ASPECT)
    expect(screenPlacement(0, 0, 0, 100, 0.5, 0, 0, 0, 1).y).toBeGreaterThan(0)
  })

  it('fades as the camera comes right up to it, and is solid from a little way off', () => {
    expect(screenFade(200, 100)).toBe(1)
    expect(screenFade(90, 100)).toBe(1)
    expect(screenFade(35, 100)).toBe(0)
    expect(screenFade(10, 100)).toBe(0)
    const mid = screenFade(62.5, 100)
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(0.6)
    expect(screenFade(10, 0)).toBe(1)
  })
})

describe('the controller’s star screen', () => {
  const host = (): ScreenHost & { want: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn> } => ({ want: vi.fn(), activate: vi.fn() })

  it('tells its host when it comes into view and folds away, once each', () => {
    const c = new BrainController()
    const h = host()
    c.setScreen({ star: 'folder:Forge', host: h })
    const v = c.version
    c.screenShown(true)
    c.screenShown(true)
    expect(h.want.mock.calls).toEqual([[true]])
    expect(c.screenOpen).toBe(true)
    expect(c.version).toBe(v + 1)
    c.screenShown(false)
    expect(h.want.mock.calls).toEqual([[true], [false]])
    expect(c.screenOpen).toBe(false)
  })

  it('takes frames only while it has a screen, and keeps them across a placeholder change', () => {
    const c = new BrainController()
    const frame = { data: new Uint8Array(16), width: 2, height: 2, bgra: true }
    c.pushScreenFrame(frame)
    expect(c.screenFrame).toBeNull()
    const h = host()
    c.setScreen({ star: 'folder:Forge', host: h, placeholder: 'Starting…' })
    const v = c.screenFrameVersion
    c.pushScreenFrame(frame)
    expect(c.screenFrame).toBe(frame)
    expect(c.screenFrameVersion).toBe(v + 1)
    c.setScreen({ star: 'folder:Forge', host: h, placeholder: 'Press g' })
    expect(c.screenFrame).toBe(frame)
    expect(c.screen?.placeholder).toBe('Press g')
  })

  it('lets go of the old host when the screen moves to another star, and activates the current one', () => {
    const c = new BrainController()
    const a = host()
    const b = host()
    c.setScreen({ star: 'folder:A', host: a })
    c.screenShown(true)
    c.pushScreenFrame({ data: new Uint8Array(4), width: 1, height: 1, bgra: false })
    c.setScreen({ star: 'folder:B', host: b })
    expect(a.want.mock.calls).toEqual([[true], [false]])
    expect(c.screenOpen).toBe(false)
    expect(c.screenFrame).toBeNull()
    c.activateScreen()
    expect(b.activate).toHaveBeenCalledOnce()
    expect(a.activate).not.toHaveBeenCalled()
    c.setScreen(null)
    c.activateScreen()
    expect(b.activate).toHaveBeenCalledOnce()
  })

  it('says how long the camera has been near its star', () => {
    const c = new BrainController()
    expect(c.nearFor(performance.now())).toBe(0)
    c.nearStar('folder:A')
    const t = performance.now()
    expect(c.nearFor(t + 500)).toBeGreaterThanOrEqual(500)
    c.nearStar(null)
    expect(c.nearFor(t + 500)).toBe(0)
  })
})

describe('the screen layer hides what is behind it', () => {
  it('reports the rectangle it covers, for things deeper than the screen only', async () => {
    const { PerspectiveCamera, Vector3 } = await import('three')
    const { ScreenLayer } = await import('../src/scene/screenLayer')
    const layer = new ScreenLayer()
    const camera = new PerspectiveCamera(50, 1, 1, 100000)
    camera.position.set(0, 0, 1000)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    const fake = {
      screen: { star: 'folder:Forge', host: { want: vi.fn(), activate: vi.fn() } },
      layoutMode: 'system',
      graph: null as unknown,
      nearId: 'folder:Forge',
      nearFor: () => 10_000,
      screenShown: vi.fn(),
      screenFrame: null,
      screenFrameVersion: 0,
    }
    const g = { index: new Map([['folder:Forge', 0]]) }
    fake.graph = g
    for (let t = 0; t < 20; t++) layer.update(fake as never, g as never, [0, 0, 0], [100], camera, 1000 + t * 100, 0.1)
    expect(layer.visible).toBe(true)
    expect(fake.screenShown).toHaveBeenLastCalledWith(true)
    const at = (x: number, y: number, z: number) => {
      const p = new Vector3(x, y, z).project(camera)
      return { x: (p.x * 0.5 + 0.5) * 800, y: (1 - (p.y * 0.5 + 0.5)) * 800, z: p.z }
    }
    // Centre of the screen: 100 × (SCREEN_GAP + SCREEN_WIDTH × aspect / 2) above the star.
    const mid = 100 * (SCREEN_GAP + (SCREEN_WIDTH * SCREEN_DEFAULT_ASPECT) / 2)
    const behind = at(0, mid, -60)
    expect(layer.covers(behind.x, behind.y, behind.z, 800, 800)).toBe(true)
    const front = at(0, mid, 300)
    expect(layer.covers(front.x, front.y, front.z, 800, 800)).toBe(false)
    const beside = at(400, mid, -60)
    expect(layer.covers(beside.x, beside.y, beside.z, 800, 800)).toBe(false)
    // The star itself, below the screen, keeps its label.
    const star = at(0, 0, 0)
    expect(layer.covers(star.x, star.y, star.z, 800, 800)).toBe(false)
    // Folded away: it hides nothing.
    fake.nearId = 'folder:Other'
    for (let t = 0; t < 40; t++) layer.update(fake as never, g as never, [0, 0, 0], [100], camera, 5000 + t * 100, 0.1)
    expect(layer.covers(behind.x, behind.y, behind.z, 800, 800)).toBe(false)
    layer.dispose()
  })
})
