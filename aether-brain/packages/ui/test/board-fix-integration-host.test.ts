import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, parseBoard, type VaultFile } from '@aether/core'
import { assetFiles, boardRaw, freshApp, vaultFiles } from './board-integration-harness'

// The first test loads the whole UI package, which takes seconds on a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const vault = (files: VaultFile[] = vaultFiles()) => new MemoryVaultAdapter(files, { assets: assetFiles() })

async function hosted() {
  const app = await freshApp()
  const v = await app.open(vault())
  const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
  const outside = vi.fn()
  host.onExternalChange!(outside)
  const raw = await host.load()
  return { app, v, host, outside, raw }
}

describe('a save carries the text it was made from', () => {
  it('is judged against that text, not against what the host happened to read last', async () => {
    const { v, host, raw } = await hosted()
    // The note moved on outside, and a reload (somebody else's read) landed in the view: the text it will save was made from `theirs`.
    const theirs = raw + '\nAn AI added a line.\n'
    await v.write('Boards/Armour.md', theirs)
    const next = theirs + 'x'
    await host.save(next, theirs)
    expect(await v.read('Boards/Armour.md')).toBe(next)
  })

  it('refuses a text that was made from an older note, even though the host itself read the newest', async () => {
    const { app, v, host, raw } = await hosted()
    const theirs = raw + '\nAn AI added a line.\n'
    await v.write('Boards/Armour.md', theirs)
    // The host reads the new note (as a reload does) ...
    expect(await host.load()).toBe(theirs)
    const write = vi.spyOn(v, 'write')
    // ... but the view saves a board it made from the OLD text: stale, and it must not look fresh because the host's read is.
    const err = await host.save(boardRaw('Armour', ['Art/sky.png']), raw).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(app.hostModule.BoardChangedOutsideError)
    expect(write).not.toHaveBeenCalled()
    expect(await v.read('Boards/Armour.md')).toBe(theirs)
  })

  it('falls back to what the host read when no base is given', async () => {
    const { v, host, raw } = await hosted()
    await v.write('Boards/Armour.md', raw + '\nElsewhere.\n')
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']))).rejects.toThrow(/changed outside/)
  })
})

describe('a refusal that repeats asks for the reload again (integration-m4)', () => {
  it('tells the view on every refused save, until the note is read again', async () => {
    const { v, host, outside, raw } = await hosted()
    outside.mockClear()
    // An outside edit takes `type: board` off the note: the view cannot read it again.
    const broken = raw.replace('type: board\n', '')
    await v.write('Boards/Armour.md', broken)
    const first = outside.mock.calls.length
    expect(first).toBeGreaterThanOrEqual(1)
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']), raw)).rejects.toThrow(/changed outside/)
    const afterFirst = outside.mock.calls.length
    expect(afterFirst).toBeGreaterThan(first)
    await expect(host.load()).rejects.toThrow(/not a board/)
    // A second and a third save are refused too, and each asks again.
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']), raw)).rejects.toThrow(/changed outside/)
    expect(outside.mock.calls.length).toBeGreaterThan(afterFirst)
    const afterSecond = outside.mock.calls.length
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']), raw)).rejects.toThrow(/changed outside/)
    expect(outside.mock.calls.length).toBeGreaterThan(afterSecond)
    // The note is put right: the next ask finds a board, and the host saves again.
    await v.write('Boards/Armour.md', raw)
    expect(await host.load()).toBe(raw)
    const mine = boardRaw('Armour', ['Art/sky.png'], '2026-10-09')
    await host.save(mine, raw)
    expect(parseBoard((await v.read('Boards/Armour.md'))!).doc.items).toHaveLength(1)
  })
})
