/**
 * The canvas the board is drawn on. It owns the pixels and the input of the board and nothing else: it sizes itself to its box at the
 * screen's density, feeds pointer, wheel and touch events (in its own CSS pixels) to the controller, and draws the session once per
 * animation frame, and only when something changed (the controller's state, a picture that arrived, a retry that is due). The
 * rest of the view is React; this part never goes through it, so a drag costs a draw and no render.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { Vec2 } from '@aether/core'
import type { Ctx2D } from '../renderer'
import type { BoardSession } from './boardSession'
import { pointerInOf, wheelInOf } from './dom'
import { hexOfPixel } from './session'

/** A finger held still this long on the canvas opens the context menu. */
const LONG_PRESS_MS = 550
const LONG_PRESS_SLOP_PX = 10
/** The menu a long press and the browser's own contextmenu event both ask for opens once. */
const MENU_DEDUPE_MS = 800

export interface BoardCanvasProps {
  session: BoardSession
  /** Open the context menu at this place of the canvas (CSS pixels). */
  onContextMenu(at: Vec2): void
  /** Where the pointer is over the canvas, or null when it left (paste and drops land there). */
  onPointer(at: Vec2 | null): void
  /** The element that takes the keyboard when the canvas is pressed. */
  focusTarget: RefObject<HTMLElement | null>
}

export function BoardCanvas({ session, onContextMenu, onPointer, focusTarget }: BoardCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  // The latest callbacks, without tearing the listeners down on every render.
  const callbacks = useRef({ onContextMenu, onPointer })
  callbacks.current = { onContextMenu, onPointer }

  useEffect(() => {
    const box = wrap.current
    const el = canvas.current
    if (!box || !el) return
    const c = session.controller
    // An opaque canvas: the board paints its own background, and the browser can skip blending it with the page.
    const ctx = el.getContext('2d', { alpha: false })
    if (!ctx) return

    /* ---- size and frames ---- */
    const measure = () => {
      const r = box.getBoundingClientRect()
      c.setViewport(r.width, r.height)
    }
    let raf = 0
    const frame = () => {
      raf = 0
      const st = c.state
      const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
      const w = Math.max(1, Math.round(st.viewport.w * dpr))
      const h = Math.max(1, Math.round(st.viewport.h * dpr))
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
      }
      session.draw(ctx as unknown as Ctx2D, dpr)
    }
    const invalidate = () => {
      if (raf === 0) raf = requestAnimationFrame(frame)
    }
    measure()
    const offFrames = session.onFrameNeeded(invalidate)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(box)

    // The density changes when the window moves to another screen.
    let dprQuery: MediaQueryList | null = null
    const watchDensity = () => {
      dprQuery?.removeEventListener('change', onDensity)
      dprQuery = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`) : null
      dprQuery?.addEventListener('change', onDensity)
    }
    function onDensity() {
      watchDensity()
      invalidate()
    }
    watchDensity()

    /* ---- the sampler reads what is on the screen ---- */
    session.setSurface({
      readPixel(at) {
        const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
        const x = Math.floor(at.x * dpr)
        const y = Math.floor(at.y * dpr)
        if (x < 0 || y < 0 || x >= el.width || y >= el.height) return null
        try {
          return hexOfPixel(ctx.getImageData(x, y, 1, 1).data)
        } catch {
          return null
        }
      },
    })

    /* ---- the cursor ---- */
    const offCursor = c.subscribe((s) => {
      if (el.style.cursor !== s.cursor) el.style.cursor = s.cursor
    })
    el.style.cursor = c.state.cursor

    /* ---- pointers ---- */
    let lastType: string = 'mouse'
    let longPress: { timer: ReturnType<typeof setTimeout>; id: number; x: number; y: number } | null = null
    let lastTouchMenu = -Infinity
    const clearLongPress = () => {
      if (longPress) clearTimeout(longPress.timer)
      longPress = null
    }
    // A touch screen asks twice (our long press, the browser's contextmenu event): once is enough. A mouse asks once, whenever.
    const openMenu = (x: number, y: number, touch: boolean) => {
      const now = performance.now()
      if (touch) {
        if (now - lastTouchMenu < MENU_DEDUPE_MS) return
        lastTouchMenu = now
      }
      callbacks.current.onContextMenu({ x, y })
    }

    const onDown = (e: PointerEvent) => {
      lastType = e.pointerType
      focusTarget.current?.focus({ preventScroll: true })
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* a pointer that is already gone cannot be captured */
      }
      const r = el.getBoundingClientRect()
      const p = pointerInOf(e, r)
      session.pointerDown(p)
      clearLongPress()
      if (e.pointerType === 'touch' && e.isPrimary) {
        longPress = {
          id: e.pointerId,
          x: p.x,
          y: p.y,
          timer: setTimeout(() => {
            const lp = longPress
            longPress = null
            if (!lp) return
            // The press that started a drag or a pan on the canvas becomes a menu instead.
            c.pointerCancel({ ...p, x: lp.x, y: lp.y, buttons: 0 })
            openMenu(lp.x, lp.y, true)
          }, LONG_PRESS_MS),
        }
      } else if (e.pointerType === 'touch') clearLongPress()
    }
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      callbacks.current.onPointer({ x: e.clientX - r.left, y: e.clientY - r.top })
      if (longPress && e.pointerId === longPress.id && Math.hypot(e.clientX - r.left - longPress.x, e.clientY - r.top - longPress.y) > LONG_PRESS_SLOP_PX) clearLongPress()
      // A pen reports many points between two frames: all of them, so that a stroke follows the hand.
      const batch = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      if (batch.length > 1) for (const ev of batch) c.pointerMove(pointerInOf(ev, r))
      else c.pointerMove(pointerInOf(e, r))
    }
    const onUp = (e: PointerEvent) => {
      clearLongPress()
      c.pointerUp(pointerInOf(e, el.getBoundingClientRect()))
    }
    const onCancel = (e: PointerEvent) => {
      clearLongPress()
      c.pointerCancel(pointerInOf(e, el.getBoundingClientRect()))
    }
    const onLeave = () => {
      callbacks.current.onPointer(null)
      c.pointerLeave()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      c.wheel(wheelInOf(e, el.getBoundingClientRect()))
    }
    const onContext = (e: MouseEvent) => {
      // The browser's own menu has nothing for a board. A pen's barrel button pans (the controller's rule): no menu then.
      e.preventDefault()
      if (lastType === 'pen') return
      const r = el.getBoundingClientRect()
      openMenu(e.clientX - r.left, e.clientY - r.top, lastType === 'touch')
    }
    // The browser's own answer to a press (the focus moving to the nearest focusable box, a text selection, the middle button's
    // auto-scroll) is not wanted: it would take the focus from a note box the press has just opened. The board takes the focus itself.
    const onMouseDown = (e: MouseEvent) => e.preventDefault()

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('contextmenu', onContext)
    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('contextrestored', invalidate)
    invalidate()
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('contextmenu', onContext)
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('contextrestored', invalidate)
      clearLongPress()
      if (raf !== 0) cancelAnimationFrame(raf)
      offFrames()
      offCursor()
      ro?.disconnect()
      dprQuery?.removeEventListener('change', onDensity)
      session.setSurface(null)
    }
  }, [session, focusTarget])

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden">
      <canvas ref={canvas} className="block h-full w-full" style={{ touchAction: 'none', userSelect: 'none' }} aria-label="Reference board" />
    </div>
  )
}
