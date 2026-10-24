import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAKE_DELAY_MS, BAKE_GAP_MS, BAKE_LIMIT, ModelBaker, type BakerTimers } from '../src/main/model-baker.js'
import { MODEL_ICON_BYTES, MODEL_ICON_FILES, ModelIconCache, NO_ICON_MS } from '../src/main/model-icons.js'
import { MAX_MODEL_BYTES, MAX_MODEL_FILE_BYTES } from '../src/main/assets.js'
import { lf } from './lf.js'

/**
 * Auto-baking the pictures of 3D models: they are kept on disk between launches (never in the vault), and a background baker draws
 * every model of a vault a little after it opens, one at a time, ahead of the camera asking.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PNG = (tag: number, length = 16): Uint8Array => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(length).fill(tag)])

/* ------------------------------------------------------------------ */
/* The icons on disk                                                  */
/* ------------------------------------------------------------------ */

describe('ModelIconCache', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-icon-cache-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const key = (n: number) => ModelIconCache.key(`/vault/model-${n}.glb`, 1000 + n, 5000 + n, 256)
  const names = async () => (await fs.readdir(dir)).sort()

  it('names a picture by the file, its time, its size and the size of the picture: change any of them and it is another name', () => {
    const base = ModelIconCache.key('/v/a.glb', 100, 2000, 256)
    expect(base).toMatch(/^[0-9a-f]{40}$/)
    expect(ModelIconCache.key('/v/a.glb', 100, 2000, 256)).toBe(base)
    for (const other of [ModelIconCache.key('/v/b.glb', 100, 2000, 256), ModelIconCache.key('/v/a.glb', 101, 2000, 256), ModelIconCache.key('/v/a.glb', 100, 2001, 256), ModelIconCache.key('/v/a.glb', 100, 2000, 512)]) {
      expect(other).not.toBe(base)
    }
  })

  it('keeps a picture and gives back the same bytes, and knows nothing of one it was not given', async () => {
    const c = new ModelIconCache(path.join(dir, 'icons'))
    expect(await c.get(key(1))).toBeUndefined()
    await c.set(key(1), PNG(7))
    expect(await c.get(key(1))).toEqual(PNG(7))
    expect(await c.get(key(2))).toBeUndefined()
    expect(await names()).toEqual(['icons'])
    expect(await fs.readdir(path.join(dir, 'icons'))).toEqual([`${key(1)}.png`])
  })

  it('keeps the fact that a model has no picture, and stops believing it after a day', async () => {
    let now = 1_000_000
    const c = new ModelIconCache(dir, { now: () => now })
    await c.set(key(1), null)
    expect(await c.get(key(1))).toBeNull()
    // Written at the real clock's time: age is measured against the injected one.
    const written = (await fs.stat(path.join(dir, `${key(1)}.none`))).mtimeMs
    now = written + NO_ICON_MS - 1000
    expect(await c.get(key(1))).toBeNull()
    now = written + NO_ICON_MS + 1000
    expect(await c.get(key(1))).toBeUndefined()
    // The note is gone with it.
    expect(await names()).toEqual([])
  })

  it('lets a picture replace the note that there was none, and the note replace a picture', async () => {
    const c = new ModelIconCache(dir)
    await c.set(key(1), null)
    await c.set(key(1), PNG(3))
    expect(await names()).toEqual([`${key(1)}.png`])
    expect(await c.get(key(1))).toEqual(PNG(3))
    await c.set(key(1), null)
    expect(await names()).toEqual([`${key(1)}.none`])
    expect(await c.get(key(1))).toBeNull()
  })

  it('keeps only what is a PNG of a thumbnail’s size, and only under a name it made itself', async () => {
    const c = new ModelIconCache(dir)
    await c.set(key(1), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9))
    await c.set(key(2), new Uint8Array(0))
    await c.set(key(3), new Uint8Array([...PNG(1).slice(0, 8), ...new Uint8Array(17 * 1024 * 1024)]))
    for (const bad of ['../escape', 'a/b', 'ABCDEF', '', `${key(1)}.png`, 'x'.repeat(40)]) {
      await c.set(bad, PNG(1))
      expect(await c.get(bad)).toBeUndefined()
    }
    expect(await names()).toEqual([])
  })

  it('throws away a file that is no picture of ours, and answers as if it had never been there', async () => {
    const c = new ModelIconCache(dir)
    await fs.writeFile(path.join(dir, `${key(1)}.png`), 'this is not a picture, though it has the right name')
    expect(await c.get(key(1))).toBeUndefined()
    expect(await names()).toEqual([])
  })

  it('makes a picture young again when it is used, so what is used stays and what is not ages out', async () => {
    // A date a file system keeps whole (some wrap seconds past 2^32), later than any real file's.
    const LATER = 2_000_000_000_000
    const c = new ModelIconCache(dir, { now: () => LATER })
    await c.set(key(1), PNG(1))
    const file = path.join(dir, `${key(1)}.png`)
    await fs.utimes(file, new Date(1000), new Date(1000))
    await c.get(key(1))
    for (let i = 0; i < 100 && (await fs.stat(file)).mtimeMs < LATER - 1000; i++) await new Promise((r) => setTimeout(r, 10))
    expect((await fs.stat(file)).mtimeMs).toBe(LATER)
  })

  it('writes whole files and renames them in: no half-written picture, and no temporary file left behind', async () => {
    const c = new ModelIconCache(dir)
    await Promise.all([1, 2, 3, 4, 5].map((n) => c.set(key(n), PNG(n, 4000))))
    const kept = await names()
    expect(kept).toHaveLength(5)
    expect(kept.every((n) => /^[0-9a-f]{40}\.png$/.test(n))).toBe(true)
  })

  it('does not leave a temporary file when the write fails, and says so', async () => {
    // A file where its folder should be: nothing can be written under it.
    const blocked = path.join(dir, 'blocked')
    await fs.writeFile(blocked, 'x')
    const c = new ModelIconCache(path.join(blocked, 'icons'))
    await expect(c.set(key(1), PNG(1))).rejects.toThrow()
    expect(await names()).toEqual(['blocked'])
  })

  it('does not leave a temporary file when it cannot put the picture in place, and says so', async () => {
    const c = new ModelIconCache(dir)
    // A folder where the picture should go: the temporary file is written and cannot be renamed over it.
    await fs.mkdir(path.join(dir, `${key(1)}.png`))
    await expect(c.set(key(1), PNG(1))).rejects.toThrow()
    expect(await names()).toEqual([`${key(1)}.png`])
  })

  it('does not take anything away while it is under its limits, however close', async () => {
    const c = new ModelIconCache(dir, { maxFiles: 10 })
    for (let n = 0; n < 9; n++) await c.set(key(n), PNG(n))
    await c.prune()
    expect((await names()).filter((n) => n.endsWith('.png'))).toHaveLength(9)
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-icon-bytes-'))
    try {
      const b = new ModelIconCache(d, { maxBytes: 100 })
      await b.set(key(1), PNG(1, 37))
      await b.set(key(2), PNG(2, 37))
      await b.prune()
      expect((await fs.readdir(d)).filter((n) => n.endsWith('.png'))).toHaveLength(2)
    } finally {
      await fs.rm(d, { recursive: true, force: true })
    }
  })

  it('keeps to its limits: the oldest pictures go first, down to a fifth under', async () => {
    const c = new ModelIconCache(dir, { maxFiles: 10 })
    for (let n = 0; n < 14; n++) {
      await c.set(key(n), PNG(n))
      await fs.utimes(path.join(dir, `${key(n)}.png`), new Date(1_000_000 + n * 1000), new Date(1_000_000 + n * 1000))
    }
    await c.prune()
    const left = (await names()).filter((n) => n.endsWith('.png'))
    expect(left).toHaveLength(8)
    // The six oldest are the ones gone: 0 to 5. 6 to 13 stay.
    for (let n = 0; n < 14; n++) expect(left.includes(`${key(n)}.png`), `picture ${n}`).toBe(n >= 6)
  })

  it('does the same by size, and leaves alone what is under its limits and what is not its own', async () => {
    const c = new ModelIconCache(dir, { maxBytes: 100 })
    // The oldest file of the folder, so it would be the first to go if it were counted.
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not ours')
    await fs.utimes(path.join(dir, 'notes.txt'), new Date(500), new Date(500))
    await c.set(key(1), PNG(1, 30))
    await fs.utimes(path.join(dir, `${key(1)}.png`), new Date(1000), new Date(1000))
    await c.prune()
    expect(await names()).toEqual(['notes.txt', `${key(1)}.png`].sort())
    await c.set(key(2), PNG(2, 60))
    await c.set(key(3), PNG(3, 60))
    await fs.utimes(path.join(dir, `${key(2)}.png`), new Date(2000), new Date(2000))
    await c.prune()
    const left = await names()
    expect(left).toContain('notes.txt')
    expect(left).toContain(`${key(3)}.png`)
    expect(left).not.toContain(`${key(1)}.png`)
  })

  it('clears out an old temporary file (a write that did not finish) and leaves a new one, and prunes by itself every 64 pictures', async () => {
    const c = new ModelIconCache(dir, { maxFiles: 20 })
    const oldTemp = path.join(dir, `${key(1)}.png.1.1.tmp`)
    const newTemp = path.join(dir, `${key(2)}.png.1.2.tmp`)
    await fs.writeFile(oldTemp, 'x')
    await fs.writeFile(newTemp, 'x')
    await fs.utimes(oldTemp, new Date(1000), new Date(1000))
    for (let n = 0; n < 63; n++) await c.set(key(100 + n), PNG(n))
    // Nothing prunes before the 64th picture.
    expect((await names()).filter((n) => n.endsWith('.png'))).toHaveLength(63)
    expect(await names()).toContain(path.basename(oldTemp))
    await c.set(key(163), PNG(63))
    // The 64th starts a prune by itself (nobody calls it): wait for it to finish.
    for (let i = 0; i < 200 && (await names()).includes(path.basename(oldTemp)); i++) await new Promise((r) => setTimeout(r, 10))
    for (let i = 0; i < 200 && (await names()).filter((n) => n.endsWith('.png')).length > 16; i++) await new Promise((r) => setTimeout(r, 10))
    expect(await names()).not.toContain(path.basename(oldTemp))
    expect(await names()).toContain(path.basename(newTemp))
    expect((await names()).filter((n) => n.endsWith('.png')).length).toBeLessThanOrEqual(16)
  })

  it('forgets every picture it kept, and only those', async () => {
    const c = new ModelIconCache(dir)
    await c.set(key(1), PNG(1))
    await c.set(key(2), null)
    await fs.writeFile(path.join(dir, 'other.txt'), 'x')
    await c.clear()
    expect(await names()).toEqual(['other.txt'])
  })

  it('has limits of a size a cache of pictures can have, and lives in no file of the vault', () => {
    expect(MODEL_ICON_BYTES).toBe(192 * 1024 * 1024)
    expect(MODEL_ICON_FILES).toBe(6000)
    expect(NO_ICON_MS).toBe(24 * 60 * 60 * 1000)
    const src = lf(readFileSync(path.join(here, '..', 'src', 'main', 'model-icons.ts'), 'utf8'))
    // It writes only into the folder it was given: nothing of the vault's is imported.
    expect(src).not.toMatch(/FsVault|fsvault|vault\./)
  })
})

/* ------------------------------------------------------------------ */
/* The baker                                                          */
/* ------------------------------------------------------------------ */

/** A clock that only moves when told to: `advance` runs what is due, in order, as time passes. */
function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: BakerTimers = {
    setTimeout(fn, ms) {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(t) {
      pending.delete(t as number)
    },
  }
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  return {
    timers,
    get now() {
      return now
    },
    get waiting() {
      return pending.size
    },
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        await flush()
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        pending.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = until
      await flush()
    },
  }
}

describe('ModelBaker', () => {
  const OPTS = { delayMs: 1000, gapMs: 100, limit: 3 }

  function rig(list: string[], opts = OPTS, results: Record<string, boolean | Error> = {}) {
    const clock = fakeTimers()
    const baked: string[] = []
    const baker = new ModelBaker(
      async (p) => {
        baked.push(p)
        const r = results[p] ?? true
        if (r instanceof Error) throw r
        return r
      },
      () => list,
      opts,
      clock.timers,
    )
    return { baker, clock, baked }
  }

  /** A baker whose bakes end when the test says so, to see what is in flight when something else happens. */
  function manual(list: string[], opts = { ...OPTS, limit: 10 }) {
    const clock = fakeTimers()
    const started: string[] = []
    const ends: ((drew: boolean) => void)[] = []
    const baker = new ModelBaker(
      (p) => {
        started.push(p)
        return new Promise<boolean>((resolve) => ends.push(resolve))
      },
      () => list,
      opts,
      clock.timers,
    )
    /** The oldest bake still going ends. */
    const finish = async (drew = true) => {
      ends.shift()?.(drew)
      await clock.advance(0)
    }
    return { baker, clock, started, finish }
  }

  it('waits the delay after the vault opens before it bakes anything, then does the models in the order it was given', async () => {
    const t = rig(['a.glb', 'b.glb'], { ...OPTS, limit: 10 })
    t.baker.start()
    await t.clock.advance(999)
    expect(t.baked).toEqual([])
    await t.clock.advance(1)
    expect(t.baked).toEqual(['a.glb'])
    await t.clock.advance(100)
    expect(t.baked).toEqual(['a.glb', 'b.glb'])
  })

  it('does one at a time, and rests after each picture it had to draw', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb'], { ...OPTS, limit: 10 })
    t.baker.start()
    await t.clock.advance(1000)
    expect(t.baked).toEqual(['a.glb'])
    await t.clock.advance(99)
    expect(t.baked).toEqual(['a.glb'])
    await t.clock.advance(1)
    expect(t.baked).toEqual(['a.glb', 'b.glb'])
    await t.clock.advance(100)
    expect(t.baked).toEqual(['a.glb', 'b.glb', 'c.glb'])
    expect(t.baker.baked).toBe(3)
    expect(t.baker.pending).toBe(0)
  })

  it('does not rest after a model that was already baked (a look at the disk), and does not count it', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb', 'd.glb'], { ...OPTS, limit: 2 }, { 'a.glb': false, 'b.glb': false, 'c.glb': false })
    t.baker.start()
    await t.clock.advance(1000)
    // The three that were baked are looked at at once; the fourth is drawn.
    expect(t.baked).toEqual(['a.glb', 'b.glb', 'c.glb', 'd.glb'])
    expect(t.baker.baked).toBe(1)
  })

  it('stops after its limit of pictures it had to draw, and leaves the rest to be drawn when they are seen', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb', 'd.glb', 'e.glb'])
    t.baker.start()
    await t.clock.advance(10_000)
    expect(t.baked).toEqual(['a.glb', 'b.glb', 'c.glb'])
    expect(t.baker.baked).toBe(3)
    expect(t.baker.pending).toBe(0)
  })

  it('bakes a model that was just added or changed first, and past the limit, and once', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb', 'd.glb'])
    t.baker.start()
    await t.clock.advance(10_000)
    expect(t.baked).toEqual(['a.glb', 'b.glb', 'c.glb'])
    t.baker.add(['new.glb', 'newer.glb', 'new.glb'])
    await t.clock.advance(1000)
    expect(t.baked.slice(3).sort()).toEqual(['new.glb', 'newer.glb'])
    // The limit counts what came from the vault's list: the new ones did not use it up, nor lift it.
    expect(t.baker.baked).toBe(3)
  })

  it('puts a model added during the delay ahead of the vault’s own list', async () => {
    const t = rig(['a.glb', 'b.glb'], { ...OPTS, limit: 10 })
    t.baker.start()
    await t.clock.advance(500)
    t.baker.add(['hot.glb'])
    await t.clock.advance(500)
    await t.clock.advance(300)
    expect(t.baked).toEqual(['hot.glb', 'a.glb', 'b.glb'])
  })

  it('puts a model added while others wait ahead of them, and does not queue one that is already waiting twice', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb', 'd.glb'], { ...OPTS, limit: 10 })
    t.baker.start()
    await t.clock.advance(1000)
    expect(t.baked).toEqual(['a.glb'])
    t.baker.add(['hot.glb', 'c.glb'])
    expect(t.baker.pending).toBe(4)
    await t.clock.advance(1000)
    expect(t.baked).toEqual(['a.glb', 'hot.glb', 'c.glb', 'b.glb', 'd.glb'])
  })

  it('never has two bakes going at once, even when a model is added while one is drawn', async () => {
    const t = manual(['a.glb', 'b.glb', 'c.glb'])
    t.baker.start()
    await t.clock.advance(1000)
    t.baker.add(['hot.glb'])
    await t.clock.advance(0)
    expect(t.started).toEqual(['a.glb'])
    await t.finish()
    await t.clock.advance(100)
    expect(t.started).toEqual(['a.glb', 'hot.glb'])
  })

  it('drops a bake that was still going when it was stopped: it does not count for anything, and nothing follows it', async () => {
    const t = manual(['a.glb', 'b.glb'])
    t.baker.start()
    await t.clock.advance(1000)
    expect(t.started).toEqual(['a.glb'])
    t.baker.stop()
    await t.finish()
    await t.clock.advance(10_000)
    expect(t.started).toEqual(['a.glb'])
    expect(t.baker.baked).toBe(0)
  })

  it('does not let the end of an old vault’s bake free the new vault’s baker for a second one', async () => {
    const t = manual(['a.glb', 'b.glb', 'c.glb'])
    t.baker.start()
    await t.clock.advance(1000)
    t.baker.stop()
    t.baker.start()
    await t.clock.advance(1000)
    expect(t.started).toEqual(['a.glb', 'a.glb'])
    // The first vault's bake ends (and is dropped); the second vault's is still going.
    await t.finish()
    t.baker.add(['hot.glb'])
    await t.clock.advance(0)
    expect(t.started).toEqual(['a.glb', 'a.glb'])
    await t.finish()
    await t.clock.advance(100)
    expect(t.started).toEqual(['a.glb', 'a.glb', 'hot.glb'])
  })

  it('does nothing when the wait ends after it was stopped and the timer could not be taken back', async () => {
    const clock = fakeTimers()
    const late: BakerTimers = { setTimeout: clock.timers.setTimeout, clearTimeout: () => undefined }
    const baked: string[] = []
    const baker = new ModelBaker(async (p) => (baked.push(p), true), () => ['a.glb'], OPTS, late)
    baker.start()
    baker.stop()
    await clock.advance(5000)
    expect(baked).toEqual([])
    expect(baker.pending).toBe(0)
  })

  it('ignores a model that was added when no vault was opening: there is nothing to bake it into', async () => {
    const t = rig(['a.glb'])
    t.baker.add(['x.glb'])
    expect(t.baker.pending).toBe(0)
    await t.clock.advance(5000)
    expect(t.baked).toEqual([])
  })

  it('forgets everything when it is stopped, and a bake in flight does not carry on', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb'], { ...OPTS, limit: 10 })
    t.baker.start()
    await t.clock.advance(1000)
    expect(t.baked).toEqual(['a.glb'])
    t.baker.stop()
    expect(t.baker.pending).toBe(0)
    expect(t.baker.baked).toBe(0)
    await t.clock.advance(10_000)
    expect(t.baked).toEqual(['a.glb'])
    // A stop before the delay is over bakes nothing at all.
    const u = rig(['a.glb'])
    u.baker.start()
    u.baker.stop()
    await u.clock.advance(10_000)
    expect(u.baked).toEqual([])
    expect(u.clock.waiting).toBe(0)
  })

  it('starts over for the next vault: its own list, its own delay, a limit of its own', async () => {
    const clock = fakeTimers()
    let list = ['a.glb', 'b.glb', 'c.glb', 'd.glb']
    const baked: string[] = []
    const baker = new ModelBaker(async (p) => (baked.push(p), true), () => list, OPTS, clock.timers)
    baker.start()
    await clock.advance(10_000)
    expect(baked).toEqual(['a.glb', 'b.glb', 'c.glb'])
    list = ['x.glb', 'y.glb']
    baker.start()
    await clock.advance(999)
    expect(baked).toHaveLength(3)
    await clock.advance(10_000)
    expect(baked.slice(3)).toEqual(['x.glb', 'y.glb'])
    expect(baker.baked).toBe(2)
  })

  it('starting twice makes one baker: the first start’s wait is cancelled', async () => {
    const t = rig(['a.glb'])
    t.baker.start()
    await t.clock.advance(500)
    t.baker.start()
    expect(t.clock.waiting).toBe(1)
    await t.clock.advance(2000)
    expect(t.baked).toEqual(['a.glb'])
  })

  it('never throws: a model that cannot be baked is left for when it is seen, and the next one is baked', async () => {
    const t = rig(['a.glb', 'b.glb', 'c.glb'], { ...OPTS, limit: 10 }, { 'a.glb': new Error('the helper stopped') })
    t.baker.start()
    await t.clock.advance(10_000)
    expect(t.baked).toEqual(['a.glb', 'b.glb', 'c.glb'])
    expect(t.baker.baked).toBe(2)
    // A list that cannot be made (the vault closed under it) is an empty one.
    const clock = fakeTimers()
    const baker = new ModelBaker(async () => true, () => {
      throw new Error('no vault')
    }, OPTS, clock.timers)
    baker.start()
    await clock.advance(5000)
    expect(baker.pending).toBe(0)
  })

  it('does not bake a model twice when the list names it twice, or a change names it as it waits', async () => {
    const t = rig(['a.glb', 'a.glb', 'b.glb'], { ...OPTS, limit: 10 })
    t.baker.start()
    await t.clock.advance(500)
    // Named again by a change while it waits: once, and ahead of the list.
    t.baker.add(['b.glb', 'b.glb'])
    await t.clock.advance(10_000)
    expect(t.baked).toEqual(['b.glb', 'a.glb'])
  })

  it('has a delay, a rest and a limit that are kind to a computer in use, and runs on the real clock when it is not given one', async () => {
    expect(BAKE_DELAY_MS).toBeGreaterThanOrEqual(10_000)
    expect(BAKE_GAP_MS).toBeGreaterThanOrEqual(100)
    expect(BAKE_LIMIT).toBeLessThanOrEqual(400)
    const baker = new ModelBaker(async () => true, () => [])
    baker.start()
    baker.add(['x.glb'])
    baker.stop()
    expect(baker.pending).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* How main uses them                                                 */
/* ------------------------------------------------------------------ */

describe('main and the baker', () => {
  const main = lf(readFileSync(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8'))

  it('keeps a model’s pictures in its own data folder, and looks there before it draws', () => {
    expect(main).toContain("new ModelIconCache(path.join(app.getPath('userData'), 'model-icons'))")
    expect(main).toContain('renderModelIcon(abs, st.mtimeMs, st.size, px)')
    expect(main).toMatch(/async function renderModelIcon\([^)]*\)[^{]*\{\n  const key = ModelIconCache\.key\(abs, mtimeMs, size, px\)\n  const kept = await modelIcons\.get\(key\)\n  if \(kept !== undefined\) return kept/)
    expect(main).toContain('await modelIcons.set(key, png).catch(() => undefined)')
  })

  it('bakes the sizes the brain and a board ask for, and tells work from a look at the disk by what the helper drew', () => {
    expect(main).toContain('const MODEL_ICON_SIZES = [512, 256]')
    expect(main).toContain('return modelIconsDrawn > before')
    expect(main).toContain('for (const px of MODEL_ICON_SIZES) await thumbnail(rel, px)')
  })

  it('starts it once a vault is loaded, feeds it new and changed models, and stops it when the vault changes and when the app quits', () => {
    expect(main).toContain('if (latest()) baker.start()')
    expect(main).toContain('baker.add(changedModels(changes))')
    expect(main).toMatch(/thumbs\.clear\(\)\n  baker\.stop\(\)/)
    expect(main).toMatch(/app\.on\('before-quit', \(e\) => \{\n  baker\.stop\(\)/)
  })

  it('lists only models, newest first, from the picture ledger of the scan', () => {
    expect(main).toContain('.filter((a) => isModelName(path.posix.basename(a.path)))')
    expect(main).toContain('.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))')
    expect(main).toContain("(c.kind === 'add' || c.kind === 'change') && isModelName(path.posix.basename(c.path))")
  })
})

/* ------------------------------------------------------------------ */
/* What the docs say                                                  */
/* ------------------------------------------------------------------ */

describe('the docs on a model’s picture', () => {
  const cosmology = lf(readFileSync(path.join(here, '..', '..', '..', 'docs', 'COSMOLOGY.md'), 'utf8'))
  const claude = lf(readFileSync(path.join(here, '..', '..', '..', 'CLAUDE.md'), 'utf8'))

  it('quote the limits the code has', () => {
    expect(MAX_MODEL_BYTES).toBe(64 * 1024 * 1024)
    expect(MAX_MODEL_FILE_BYTES).toBe(2 * 1024 * 1024 * 1024)
    expect(cosmology).toContain(`up to **${MAX_MODEL_FILE_BYTES / 1024 ** 3} GB**`)
    expect(cosmology).toContain(`A file over ${MAX_MODEL_BYTES / 1024 ** 2} MB is not read whole`)
    expect(cosmology).toContain(`at most ${MODEL_ICON_BYTES / 1024 ** 2} MB and ${MODEL_ICON_FILES.toLocaleString('en-US')} pictures`)
    expect(cosmology).toContain(`at most ${BAKE_LIMIT} drawn per start`)
    expect(cosmology).toContain(`a file over ${MAX_MODEL_FILE_BYTES / 1024 ** 3} GB gets no still`)
    expect(claude).toContain(`${MODEL_ICON_BYTES / 1024 ** 2} MB / ${MODEL_ICON_FILES.toLocaleString('en-US')} files`)
    expect(claude).toContain(`${BAKE_LIMIT} per start`)
  })

  it('say what is kept and where, and that the vault is never written to', () => {
    expect(cosmology).toContain('`model-icons`')
    expect(cosmology).toContain('never in the vault')
    expect(claude).toContain('`userData/model-icons` (never in the vault')
    expect(claude).toContain('model-icons.ts (ModelIconCache')
    expect(claude).toContain('model-baker.ts (ModelBaker')
  })
})
