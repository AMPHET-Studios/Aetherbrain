import { describe, expect, it } from 'vitest'
import {
  BOARD_WINDOW_NAME,
  BRAIN_WINDOW_NAME,
  CRASH_RELOADS,
  CRASH_WINDOW_MS,
  MEMORY_TRAIL,
  MemoryTrail,
  crashMessage,
  crashReport,
  crashReportName,
  describeTrail,
  shouldReload,
} from '../src/main/crash'

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

  it('names the window that died: the brain window by default, the board window when it says so (desktop-m8)', () => {
    expect(BRAIN_WINDOW_NAME).toBe('Aether Brain window')
    expect(crashMessage('crashed', true).message).toBe(crashMessage('crashed', true, BRAIN_WINDOW_NAME).message)
    expect(crashMessage('oom', true, BOARD_WINDOW_NAME).message).toBe('The board window ran out of memory.')
    // The board window's reassurance is about its board, not "your notes": a note still being typed is not in it.
    expect(crashMessage('oom', true, BOARD_WINDOW_NAME).detail).toContain('A note you were still typing is not in it')
    expect(crashMessage('oom', true, BOARD_WINDOW_NAME).detail).not.toContain('Your notes are the files on disk')
    // Crashes 20 to 30 seconds apart are not "right after opening".
    expect(crashMessage('oom', false).detail).toContain('several times within a minute')
    expect(crashMessage('oom', false).detail).not.toContain('right after opening')
  })
})

describe('what the memory did before a page died', () => {
  const at = (sec: number, pageMB: number) => ({ t: 1_000_000 + sec * 1000, pageMB, mainMB: 200, gpuMB: 300 })

  it('keeps the last MEMORY_TRAIL looks, oldest first', () => {
    const trail = new MemoryTrail()
    for (let i = 0; i < MEMORY_TRAIL + 25; i++) trail.add(at(i * 2, i))
    expect(trail.samples).toHaveLength(MEMORY_TRAIL)
    expect(trail.samples[0]!.pageMB).toBe(25)
    expect(trail.samples.at(-1)!.pageMB).toBe(MEMORY_TRAIL + 24)
    trail.clear()
    expect(trail.samples).toHaveLength(0)
  })

  it('says where it ended, its peak and how it got there', () => {
    const samples = [at(0, 300), at(10, 900), at(20, 1500), at(30, 3900), at(32, 3700)]
    const text = describeTrail(samples)
    expect(text).toContain('3.6 GB') // the last look
    expect(text).toContain('peak 3.8 GB')
    expect(text).toContain('900 MB 22 s earlier') // the newest look at least 20 s older than the last
  })

  it('has nothing to say without a look, and no "earlier" when there is only a short trail', () => {
    expect(describeTrail([])).toBe('')
    expect(describeTrail([at(0, 500), at(2, 520)])).toBe("The window's page was using 520 MB when it was last measured (its peak 520 MB).")
  })

  it('puts the memory and the report into the message box, after what it always says', () => {
    const plain = crashMessage('oom', true)
    const text = crashMessage('oom', true, BRAIN_WINDOW_NAME, { memory: 'It was big.', report: '/x/crash-1.json' })
    expect(text.message).toBe(plain.message)
    expect(text.detail.startsWith(plain.detail)).toBe(true)
    expect(text.detail).toContain('It was big.')
    expect(text.detail).toContain('A report was saved: /x/crash-1.json')
    expect(crashMessage('oom', true, BRAIN_WINDOW_NAME, {}).detail).toBe(plain.detail)
  })

  it('writes a report with the reason and the trail, under a name a file system takes', () => {
    const now = Date.UTC(2026, 9, 11, 12, 30, 5, 123)
    const report = crashReport({ reason: 'oom', exitCode: 36, window: BRAIN_WINDOW_NAME, version: '0.10.0', platform: 'win32', now }, [at(0, 100)])
    expect(report).toMatchObject({ app: 'Aether Brain', version: '0.10.0', reason: 'oom', exitCode: 36, time: '2026-10-11T12:30:05.123Z' })
    expect(report.memory).toEqual([at(0, 100)])
    expect(crashReportName(now)).toBe('crash-2026-10-11T12-30-05-123Z.json')
    expect(crashReportName(now)).not.toMatch(/[:]/)
  })
})
