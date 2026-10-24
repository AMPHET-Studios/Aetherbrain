import { describe, expect, it } from 'vitest'
import { addPicture, decodeProxy, emptyBoard, encodeProxy, renderProxy, serializeBoard, type ProxyParts } from '@aether/core'
import type { LiveCanvas } from '../src/board/modelViews'
import { RecordingContext } from './helpers/recordingContext'
import { rig } from './helpers/board-view-fakes'

/**
 * The board session and its 3D models: live views exist only when the host can give a model's proxy and the browser can make a canvas
 * for it; a model on the screen is asked for once and drawn again when it arrives; a model that was just added is a square of its own
 * size without a picture being read; and every close lets the views go.
 */

const Q = 32767
const SPHERE: ProxyParts = (() => {
  const lat = 8
  const lon = 12
  const positions: number[] = []
  for (let i = 0; i <= lat; i++) {
    const t = (i / lat) * Math.PI
    for (let j = 0; j < lon; j++) {
      const a = (j / lon) * Math.PI * 2
      positions.push(Math.round(Math.sin(t) * Math.cos(a) * Q), Math.round(Math.cos(t) * Q), Math.round(Math.sin(t) * Math.sin(a) * Q))
    }
  }
  const indices: number[] = []
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const a = i * lon + j
      const b = i * lon + ((j + 1) % lon)
      const c = (i + 1) * lon + j
      const d = (i + 1) * lon + ((j + 1) % lon)
      indices.push(a, c, b, b, c, d)
    }
  return { centre: [0, 0, 0], half: 1, positions, colors: Array.from({ length: positions.length / 3 }, () => [200, 80, 80]).flat(), indices }
})()
const PROXY = encodeProxy(SPHERE)

/** A board holding a model and a picture, the model 300 across so it is drawn big. */
function boardWithModel(): string {
  let doc = emptyBoard('Gate')
  doc = addPicture(doc, { path: 'Art/robot.glb', x: 0, y: 0, w: 300, h: 300 }).doc
  doc = addPicture(doc, { path: 'Art/gate.png', x: 400, y: 0, w: 200, h: 100 }).doc
  return serializeBoard(doc, undefined, new Date(2026, 9, 23, 20, 0, 0))
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function liveRig(opts: { proxy?: boolean; live?: boolean } = {}) {
  const r = rig(boardWithModel(), opts.proxy === false ? { modelProxy: false } : {}, { start: false })
  r.host.proxies['Art/robot.glb'] = PROXY
  const canvases: { side: number; painted: number; last: Uint8ClampedArray | null }[] = []
  if (opts.live !== false) {
    r.env.makeLiveCanvas = (side): LiveCanvas => {
      const rec = { side, painted: 0, last: null as Uint8ClampedArray | null }
      canvases.push(rec)
      return { image: { width: side, height: side }, paint: (pixels) => ((rec.painted += 1), (rec.last = pixels)) }
    }
  }
  const frames = { n: 0 }
  r.session.onFrameNeeded(() => void frames.n++)
  r.session.start()
  return { ...r, canvases, frames }
}

describe('the session and the live views of 3D models', () => {
  it('asks the host for a model’s proxy when a model is drawn on the screen, once, and not for a picture', async () => {
    const t = liveRig()
    const ctx = new RecordingContext()
    t.session.draw(ctx, 1)
    t.session.draw(ctx, 1)
    expect(t.host.proxyAsks).toEqual(['Art/robot.glb'])
    await flush()
    t.session.draw(ctx, 1)
    expect(t.host.proxyAsks).toEqual(['Art/robot.glb'])
  })

  it('asks for a frame when the proxy arrives, and then draws the model live: a canvas painted once and handed to the renderer', async () => {
    const t = liveRig()
    const ctx = new RecordingContext()
    t.session.draw(ctx, 1)
    const before = t.frames.n
    await flush()
    expect(t.frames.n).toBeGreaterThan(before)
    const again = new RecordingContext()
    t.session.draw(again, 1)
    expect(t.canvases).toHaveLength(1)
    expect(t.canvases[0]!.painted).toBe(1)
    const live = again.drawImages().filter((d) => (d.image as unknown as { width: number }).width === 512 || (d.image as unknown as { width: number }).width === 256)
    expect(live.length).toBeGreaterThan(0)
    // A second frame at the same view paints nothing more.
    t.session.draw(new RecordingContext(), 1)
    expect(t.canvases[0]!.painted).toBe(1)
  })

  it('draws the model as its still when the host has no proxies, or the browser no canvas: the board is as it was', async () => {
    for (const opts of [{ proxy: false }, { live: false }]) {
      const t = liveRig(opts)
      t.session.draw(new RecordingContext(), 1)
      await flush()
      t.session.draw(new RecordingContext(), 1)
      expect(t.host.proxyAsks, JSON.stringify(opts)).toEqual([])
      expect(t.canvases).toHaveLength(0)
    }
  })

  it('draws the model as its still when the host has no proxy of it (null)', async () => {
    const t = liveRig()
    t.host.proxies['Art/robot.glb'] = null
    t.session.draw(new RecordingContext(), 1)
    await flush()
    t.session.draw(new RecordingContext(), 1)
    expect(t.canvases).toHaveLength(0)
  })

  it('turns the live view when the board’s model is turned: a new picture of the model at the view its item holds', async () => {
    const t = liveRig()
    t.session.draw(new RecordingContext(), 1)
    await flush()
    t.session.draw(new RecordingContext(), 1)
    t.session.exec('tool.turn')
    t.session.pointerDown({ id: 1, x: 400, y: 300, button: 0, buttons: 1, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'mouse', pressure: 0.5, time: 0 })
    t.session.controller.pointerMove({ id: 1, x: 460, y: 300, button: 0, buttons: 1, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'mouse', pressure: 0.5, time: 10 })
    t.session.draw(new RecordingContext(), 1)
    expect(t.canvases[0]!.painted).toBe(2)
  })

  it('an export draws the model as it is turned, from its proxy, and does not read the model whole for its size', async () => {
    const t = liveRig()
    t.session.exec('tool.turn')
    const ptr = (x: number, time: number) => ({ id: 1, x, y: 300, button: 0, buttons: 1, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'mouse' as const, pressure: 0.5, time })
    t.session.pointerDown(ptr(400, 0))
    t.session.controller.pointerMove(ptr(480, 10))
    t.session.controller.pointerUp({ ...ptr(480, 20), buttons: 0 })
    t.host.originals.length = 0
    await t.session.exportItems(null, 'board')
    expect(t.host.originals).not.toContain('Art/robot.glb')
    expect(t.host.proxyAsks).toContain('Art/robot.glb')
    const drawn = t.env.canvases.flatMap((c) => c.ctx.drawImages())
    expect(drawn.length).toBeGreaterThan(0)
    const live = t.canvases.find((c) => c.painted === 1)!
    expect(drawn.some((d) => (d.image as unknown as { width: number }).width === live.side)).toBe(true)
    // The model was drawn at the view it was left in: a drag of 80 px to the right is 40 degrees less yaw (35 - 40 = 355).
    const direct = renderProxy(decodeProxy(PROXY)!, { side: live.side, yaw: 355, pitch: 24, supersample: live.side <= 256 ? 2 : 1 })!
    expect(Buffer.compare(Buffer.from(live.last!), Buffer.from(direct.pixels))).toBe(0)
    expect(t.host.added).toHaveLength(1)
  })

  it('a model added from the vault is a square tile of the size its picture is made at, with no picture read for its size', async () => {
    const t = liveRig()
    t.host.previews.length = 0
    await t.session.addVaultPictures(['Art/new.glb'])
    const added = t.session.controller.state.doc.items.find((i) => i.kind === 'picture' && i.path === 'Art/new.glb')
    // Put on the board at a size that fits the view, but square: a model has no shape of its own beyond that.
    expect(added).toBeDefined()
    expect((added as { w: number; h: number }).w).toBe((added as { w: number; h: number }).h)
    expect(t.host.previews).not.toContain('Art/new.glb')
    expect(t.session.naturalOf('Art/new.glb')).toEqual({ w: 512, h: 512 })
  })

  it('lets the views go when the view is closed', async () => {
    const t = liveRig()
    t.session.draw(new RecordingContext(), 1)
    await flush()
    t.session.stop?.()
    const asks = t.host.proxyAsks.length
    t.session.draw(new RecordingContext(), 1)
    await flush()
    expect(t.host.proxyAsks.length).toBe(asks)
  })
})
