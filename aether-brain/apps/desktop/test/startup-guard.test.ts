import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StartupGuard, latestCrash } from '../src/main/startup-guard.js'
import { crashReportName } from '../src/main/crash.js'

let dir = ''
let file = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-guard-'))
  file = path.join(dir, 'startup.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 9, 11, 2, 0, 0)

describe('StartupGuard', () => {
  it('knows nothing of a run that settled, or of no run at all', () => {
    expect(new StartupGuard(file).interrupted()).toBeNull()
    const g = new StartupGuard(file, () => T0)
    g.begin(['D:\\', 'F:\\'])
    g.settle()
    expect(existsSync(file)).toBe(false)
    expect(new StartupGuard(file).interrupted()).toBeNull()
  })

  it('remembers an open that never settled, for the next start', () => {
    const g = new StartupGuard(file, () => T0)
    g.begin(['D:\\', 'F:\\'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ roots: ['D:\\', 'F:\\'], at: '2026-10-11T02:00:00.000Z', died: false })
    // The next run starts as a new object over the same file.
    expect(new StartupGuard(file).interrupted()).toEqual({ roots: ['D:\\', 'F:\\'], at: '2026-10-11T02:00:00.000Z', died: false })
  })

  it('is still pending in the same run after the page died, so the reloaded page is told', () => {
    const g = new StartupGuard(file, () => T0)
    g.begin(['F:\\'])
    g.died()
    expect(g.interrupted()).toEqual({ roots: ['F:\\'], at: '2026-10-11T02:00:00.000Z', died: true })
    expect(new StartupGuard(file).interrupted()?.died).toBe(true)
  })

  it('forgets an open the user cut short by quitting, but not one a dead page cut short', () => {
    const quit = new StartupGuard(file, () => T0)
    quit.begin(['F:\\'])
    quit.cleanExit()
    expect(new StartupGuard(file).interrupted()).toBeNull()

    const crashed = new StartupGuard(file, () => T0)
    crashed.begin(['F:\\'])
    crashed.died()
    crashed.cleanExit()
    expect(new StartupGuard(file).interrupted()?.roots).toEqual(['F:\\'])
  })

  it('lets a new open replace the note (and clear the died mark)', () => {
    const g = new StartupGuard(file, () => T0)
    g.begin(['D:\\', 'F:\\'])
    g.died()
    g.begin(['F:\\ConceptForge'])
    expect(g.interrupted()).toEqual({ roots: ['F:\\ConceptForge'], at: '2026-10-11T02:00:00.000Z', died: false })
    g.settle()
    expect(g.interrupted()).toBeNull()
  })

  it('hands out copies, so a caller cannot change what it remembers', () => {
    const g = new StartupGuard(file, () => T0)
    g.begin(['F:\\'])
    const a = g.interrupted()!
    a.roots.push('X:\\')
    a.died = true
    expect(g.interrupted()).toEqual({ roots: ['F:\\'], at: '2026-10-11T02:00:00.000Z', died: false })
  })

  it('ignores a file that is not a note it wrote', async () => {
    for (const text of ['', 'not json', '[]', '{}', '{"roots":[],"at":"x"}', '{"roots":[1],"at":"x"}', '{"roots":["F:\\\\"]}', '{"roots":[""],"at":"x"}']) {
      await fs.writeFile(file, text)
      expect(new StartupGuard(file).interrupted(), text).toBeNull()
    }
  })

  it('keeps at most a few dozen folders, and ignores an empty list', () => {
    const g = new StartupGuard(file, () => T0)
    g.begin([])
    expect(g.interrupted()).toBeNull()
    g.begin(Array.from({ length: 200 }, (_, i) => `D:\\f${i}`))
    expect(g.interrupted()?.roots).toHaveLength(64)
  })

  it('never throws when the disk will not take the file', async () => {
    // A file where its folder should be: mkdir and write both fail.
    const blocker = path.join(dir, 'blocker')
    await fs.writeFile(blocker, 'x')
    const g = new StartupGuard(path.join(blocker, 'startup.json'), () => T0)
    expect(() => {
      g.begin(['F:\\'])
      g.died()
      g.settle()
      g.cleanExit()
    }).not.toThrow()
    expect(g.interrupted()).toBeNull()
  })
})

describe('latestCrash', () => {
  const report = (t: number, extra: object = {}) => JSON.stringify({ time: new Date(t).toISOString(), reason: 'oom', memory: [{ t, pageMB: 3000, mainMB: 200, gpuMB: 300 }], ...extra })
  async function put(t: number, extra?: object): Promise<string> {
    const f = path.join(dir, crashReportName(t))
    await fs.writeFile(f, report(t, extra))
    return f
  }

  it('is the newest report written since the open began, with its memory and vault counts', async () => {
    await put(T0 - 60_000)
    const newest = await put(T0 + 30_000, { vault: { notes: 303, folders: 140000, pictures: 52000 } })
    const got = latestCrash(dir, new Date(T0).toISOString())
    expect(got?.file).toBe(newest)
    expect(got?.reason).toBe('oom')
    expect(got?.memory).toHaveLength(1)
    expect(got?.vault).toEqual({ notes: 303, folders: 140000, pictures: 52000 })
  })

  it('is null when the newest report is older than the open (it was another crash)', async () => {
    await put(T0 - 60_000)
    expect(latestCrash(dir, new Date(T0).toISOString())).toBeNull()
  })

  it('is null for no folder, no reports, or a report that is not JSON', async () => {
    expect(latestCrash(path.join(dir, 'nope'), '2000-01-01T00:00:00.000Z')).toBeNull()
    expect(latestCrash(dir, '2000-01-01T00:00:00.000Z')).toBeNull()
    await fs.writeFile(path.join(dir, crashReportName(T0)), 'garbage')
    expect(latestCrash(dir, '2000-01-01T00:00:00.000Z')).toBeNull()
  })
})
