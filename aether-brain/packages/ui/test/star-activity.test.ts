import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, folderKey, type VaultFile } from '@aether/core'

/**
 * A star's brightness is how much you use it (docs/COSMOLOGY.md, "A star's brightness is how much you use it"): opening a note and saving
 * a change to it leave heat that fades, kept on this computer for the vault that is open; the palette forgets it.
 */

class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

async function freshStore(storage = new MemoryStorage()) {
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  const store = await import('../src/store')
  const { COMMANDS } = await import('../src/commands')
  const s = () => store.useAether.getState()
  /** The brightness the scene would draw for a folder (0 when it has none yet). */
  const heat = (id: string): number => s().controller.activity?.[s().graph!.index.get(id)!] ?? 0
  return { s, storage, commands: COMMANDS, heat }
}

afterEach(() => void vi.unstubAllGlobals())

const FILES: VaultFile[] = [
  { path: 'Home.md', content: '# Home\n' },
  { path: 'Work/Plan.md', content: '---\ntitle: Plan\n---\n# Plan\n' },
  { path: 'Work/Deep/Notes.md', content: '# Notes\n' },
  { path: 'Play/Game.md', content: '# Game\n' },
  { path: 'Quiet/Still.md', content: '# Still\n' },
]
const vault = (files: VaultFile[] = FILES) => new MemoryVaultAdapter(files)
/** The refresh after an interaction is a quarter of a second later: a burst is one. */
const settle = () => new Promise((r) => setTimeout(r, 330))

describe('what lights a star', () => {
  it('starts calm: every star has the brightness of one nobody uses', async () => {
    const { s, heat } = await freshStore()
    await s().openVault(vault())
    expect(s().controller.activity).toBeInstanceOf(Float32Array)
    expect(s().controller.activity!.length).toBe(s().graph!.nodes.length)
    for (const v of s().controller.activity!) expect(v).toBe(0)
    expect(heat(folderKey('Work'))).toBe(0)
  })

  it('opening a note brightens the folders above it, and not the others', async () => {
    const { s, heat } = await freshStore()
    await s().openVault(vault())
    s().openNote('Work/Deep/Notes')
    await settle()
    expect(heat('Work/Deep/Notes')).toBeGreaterThan(0)
    expect(heat(folderKey('Work/Deep'))).toBeGreaterThan(0)
    expect(heat(folderKey('Work'))).toBeGreaterThan(0)
    expect(heat(folderKey('Play'))).toBe(0)
    expect(heat(folderKey('Quiet'))).toBe(0)
  })

  it('counts saving a change more than opening, and the busier folder is the brighter star', async () => {
    const { s, heat } = await freshStore()
    await s().openVault(vault())
    s().openNote('Play/Game')
    await s().patchFrontmatter('Work/Plan', { status: 'active' })
    await settle()
    // One open against one save: the folder with the save is brighter.
    expect(heat(folderKey('Work'))).toBeGreaterThan(heat(folderKey('Play')))
    expect(heat(folderKey('Play'))).toBeGreaterThan(0)
  })

  it('does not count looking, only using: a click on a note, a change from outside, and a folder or a picture are not interactions', async () => {
    const { s, heat } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    s().select('Work/Plan')
    s().openNote(folderKey('Play'))
    s().applyExternal([{ kind: 'change', path: 'Quiet/Still.md', content: '# Still\n\nchanged elsewhere\n', mtime: Date.now() }])
    await settle()
    expect(heat(folderKey('Work'))).toBe(0)
    expect(heat(folderKey('Play'))).toBe(0)
    expect(heat(folderKey('Quiet'))).toBe(0)
  })

  it('counts the same note opened twice in a moment once', async () => {
    const a = await freshStore()
    await a.s().openVault(vault())
    a.s().openNote('Work/Plan')
    await settle()
    const once = a.heat(folderKey('Work'))
    a.s().openNote('Work/Plan')
    await settle()
    expect(a.heat(folderKey('Work'))).toBe(once)
  })
})

describe('where it is kept', () => {
  it('on this computer, for this vault, saved a moment after the use, and read back when the vault is opened again', async () => {
    const first = await freshStore()
    await first.s().openVault(vault())
    first.s().openNote('Play/Game')
    await settle()
    // Saved a few seconds after, not at once (a burst is one write).
    expect([...first.storage.map.keys()].some((k) => k.startsWith('aether:activity:'))).toBe(false)
    await new Promise((r) => setTimeout(r, 3000))
    const key = [...first.storage.map.keys()].find((k) => k.startsWith('aether:activity:'))!
    expect(key).toBeTruthy()
    expect(JSON.parse(first.storage.map.get(key)!)).toMatchObject({ v: 1, e: { 'Play/Game': [expect.any(Number), expect.any(Number)] } })
    // A fresh app on the same storage: the star is bright from the start.
    const again = await freshStore(first.storage)
    await again.s().openVault(vault())
    expect(again.heat(folderKey('Play'))).toBeGreaterThan(0)
    expect(again.heat(folderKey('Work'))).toBe(0)
  }, 15_000)

  it('never in the vault: nothing is written to it', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    s().openNote('Play/Game')
    await settle()
    // The note is as it was, and no file for the use appeared: the notes of the vault are exactly the ones it had.
    expect(await adapter.read('Play/Game.md')).toBe('# Game\n')
    expect(s().notes.size).toBe(FILES.length)
    expect([...s().notes.keys()].sort()).toEqual(['Home', 'Play/Game', 'Quiet/Still', 'Work/Deep/Notes', 'Work/Plan'])
  })

  it('ignores garbage in storage: the stars start calm and nothing throws', async () => {
    const storage = new MemoryStorage()
    storage.setItem('aether:activity:memory://', '{not json')
    const { s, heat } = await freshStore(storage)
    await s().openVault(vault())
    expect(heat(folderKey('Work'))).toBe(0)
    storage.setItem('aether:activity:memory://', JSON.stringify({ v: 1, e: { 'Play/Game': ['x', null], 'Work/Plan': [-3, 1] } }))
    const again = await freshStore(storage)
    await again.s().openVault(vault())
    expect(again.heat(folderKey('Play'))).toBe(0)
  })
})

describe('forgetting it', () => {
  it('makes every star calm again, empties the saved copy, and says so', async () => {
    const { s, heat, storage } = await freshStore()
    await s().openVault(vault())
    s().openNote('Work/Plan')
    await settle()
    expect(heat(folderKey('Work'))).toBeGreaterThan(0)
    s().forgetActivity()
    expect(heat(folderKey('Work'))).toBe(0)
    expect(s().toasts.at(-1)).toMatchObject({ text: 'Forgot which folders you use: every star is calm again', kind: 'success' })
    const key = [...storage.map.keys()].find((k) => k.startsWith('aether:activity:'))!
    expect(JSON.parse(storage.map.get(key)!)).toEqual({ v: 1, e: {} })
    // And it counts afresh from here.
    s().openNote('Work/Plan')
    await settle()
    expect(heat(folderKey('Work'))).toBeGreaterThan(0)
  })

  it('is a palette command, shown while the system layout is, and it works from there', async () => {
    const { s, commands, heat } = await freshStore()
    await s().openVault(vault())
    const cmd = commands.find((c) => c.id === 'activity-forget')!
    expect(cmd.title).toBe('Forget which folders I use (every star goes calm)')
    expect(cmd.when!(s())).toBe(true)
    s().openNote('Play/Game')
    await settle()
    expect(heat(folderKey('Play'))).toBeGreaterThan(0)
    await cmd.run(s())
    expect(heat(folderKey('Play'))).toBe(0)
  })
})
