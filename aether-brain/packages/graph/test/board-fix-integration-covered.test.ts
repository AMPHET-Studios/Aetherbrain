import { describe, expect, it, vi } from 'vitest'
import { BrainController } from '../src/BrainController'
import { frameloopFor } from '../src/scene/frameloop'

/*
 * The 3D view is not drawn while a full-window panel (the Boards view, the Projects board) covers it (integration-3, live-docked-1:
 * the brain behind an open board took the main thread, 1.3 fps against 34 fps once it was paused). The controller holds the switch,
 * the scene reads it through the same subscription as `restBehind`, and `frameloopFor` is the one rule the Canvas follows.
 */

describe('the scene covered by a panel', () => {
  it('is a switch the 3D view listens to, and only tells it when it changes', () => {
    const c = new BrainController()
    const seen = vi.fn()
    const off = c.subscribe(seen)
    expect(c.covered).toBe(false)
    c.setCovered(false)
    expect(seen).not.toHaveBeenCalled()
    c.setCovered(true)
    expect(c.covered).toBe(true)
    expect(seen).toHaveBeenCalledTimes(1)
    c.setCovered(true)
    expect(seen).toHaveBeenCalledTimes(1)
    c.setCovered(false)
    expect(c.covered).toBe(false)
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    c.dispose()
  })

  it('moves the controller’s version each way, so a scene that reads it draws again once it is uncovered', () => {
    const c = new BrainController()
    const v = c.version
    c.setCovered(true)
    expect(c.version).toBeGreaterThan(v)
    const covered = c.version
    c.setCovered(false)
    expect(c.version).toBeGreaterThan(covered)
    c.dispose()
  })

  it('is independent of resting behind a viewer: one does not clear the other', () => {
    const c = new BrainController()
    c.setRestBehind(true)
    c.setCovered(true)
    c.setCovered(false)
    expect(c.restBehind).toBe(true)
    expect(c.covered).toBe(false)
    c.setCovered(true)
    c.setRestBehind(false)
    expect(c.covered).toBe(true)
    c.dispose()
  })

  it('leaves the layout and the controller’s other state alone: motion, bloom and hub labels are what they were on the way back', () => {
    const c = new BrainController()
    c.setMotion(true)
    c.setBloom(false)
    c.setCovered(true)
    c.setMotion(false)
    c.setMotion(true)
    c.setCovered(false)
    expect(c.motion).toBe(true)
    expect(c.bloom).toBe(false)
    expect(c.engine.positionOf('nothing')).toBeNull()
    c.dispose()
  })
})

describe('the rule the Canvas follows', () => {
  it('never draws while covered, whatever else is true', () => {
    for (const restBehind of [false, true]) for (const front of [false, true]) expect(frameloopFor({ covered: true, restBehind, front })).toBe('never')
  })

  it('keeps the viewer rule: rests only when it rests behind a viewer and its window is not in front', () => {
    expect(frameloopFor({ covered: false, restBehind: true, front: false })).toBe('never')
    expect(frameloopFor({ covered: false, restBehind: true, front: true })).toBe('always')
    expect(frameloopFor({ covered: false, restBehind: false, front: false })).toBe('always')
    expect(frameloopFor({ covered: false, restBehind: false, front: true })).toBe('always')
  })

  it('draws again the moment nothing covers it', () => {
    const c = new BrainController()
    const rule = () => frameloopFor({ covered: c.covered, restBehind: c.restBehind, front: true })
    expect(rule()).toBe('always')
    c.setCovered(true)
    expect(rule()).toBe('never')
    c.setCovered(false)
    expect(rule()).toBe('always')
    c.dispose()
  })
})
