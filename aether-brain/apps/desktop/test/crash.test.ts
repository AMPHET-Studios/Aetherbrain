import { describe, expect, it } from 'vitest'
import { CRASH_RELOADS, CRASH_WINDOW_MS, crashMessage, shouldReload } from '../src/main/crash'

describe('a window whose page died', () => {
  it('is opened again, but not when it keeps dying right after', () => {
    const t = 1_000_000
    expect(shouldReload([t], t)).toBe(true)
    // Up to CRASH_RELOADS reloads inside the window; the crash after those is left alone.
    const times = Array.from({ length: CRASH_RELOADS }, (_, i) => t + i * 5_000)
    expect(shouldReload(times, times.at(-1)!)).toBe(true)
    const dying = [...times, t + CRASH_RELOADS * 5_000]
    expect(shouldReload(dying, dying.at(-1)!)).toBe(false)
  })

  it('counts only the crashes of the last minute: an old one is forgotten', () => {
    const t = 5_000_000
    const old = [t - CRASH_WINDOW_MS - 1, t - CRASH_WINDOW_MS - 2, t - CRASH_WINDOW_MS - 3]
    expect(shouldReload([...old, t], t)).toBe(true)
    // Two inside the last minute (the first just still counts): still opened again; a third makes it stop.
    expect(shouldReload([t - CRASH_WINDOW_MS + 1_000, t], t)).toBe(true)
    expect(shouldReload([t - CRASH_WINDOW_MS + 1_000, t - 30_000, t], t)).toBe(false)
  })

  it('says why in plain words, and whether it is opening again', () => {
    expect(crashMessage('oom', true).message).toBe('The Aether Brain window ran out of memory.')
    expect(crashMessage('crashed', true).message).toBe('The Aether Brain window crashed.')
    expect(crashMessage('killed', true).message).toContain('stopped by the system')
    expect(crashMessage('launch-failed', true).message).toContain('could not start')
    expect(crashMessage('oom', true).detail).toContain('opening again')
    expect(crashMessage('oom', true).detail).toContain('not touched')
    expect(crashMessage('oom', false).detail).toContain('left closed')
    expect(crashMessage('oom', false).detail).not.toContain('opening again')
  })
})
