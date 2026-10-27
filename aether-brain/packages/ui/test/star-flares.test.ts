import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, type VaultFile } from '@aether/core'

/**
 * Corona ejections in the app (docs/COSMOLOGY.md, "A star that needs you erupts"): a setting (on, unless this computer asks for less
 * motion), the key Shift+F and a palette command to switch them, and plain f still flies to the selection.
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

async function freshStore(opts: { storage?: MemoryStorage; reducedMotion?: boolean } = {}) {
  const storage = opts.storage ?? new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  if (opts.reducedMotion !== undefined) {
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: opts.reducedMotion === true && /reduce/.test(q) }), addEventListener: () => undefined, removeEventListener: () => undefined })
  }
  vi.resetModules()
  const store = await import('../src/store')
  const { COMMANDS } = await import('../src/commands')
  const { handleKey } = await import('../src/hooks/useKeyboard')
  const press = (key: string, shiftKey = false) =>
    handleKey({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey,
      target: { tagName: 'BODY', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false },
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyboardEvent)
  return { s: () => store.useAether.getState(), set: store.useAether.setState, storage, commands: COMMANDS, press }
}

afterEach(() => void vi.unstubAllGlobals())

const FILES: VaultFile[] = [
  { path: 'Home.md', content: '# Home\n' },
  { path: 'Work/Plan.md', content: '# Plan\n' },
]
const vault = () => new MemoryVaultAdapter(FILES)

describe('the setting', () => {
  it('is on to begin with, and the scene is told', async () => {
    const { s } = await freshStore()
    expect(s().settings.flares).toBe(true)
    expect(s().controller.flares).toBe(true)
  })

  it('switches off and on, tells the scene, says so, and is remembered', async () => {
    const { s, storage } = await freshStore()
    s().toggleFlares()
    expect(s().settings.flares).toBe(false)
    expect(s().controller.flares).toBe(false)
    expect(s().toasts.at(-1)?.text).toBe('Solar flares off')
    expect(JSON.parse(storage.map.get('aether:settings')!).flares).toBe(false)
    s().toggleFlares()
    expect(s().controller.flares).toBe(true)
    expect(s().toasts.at(-1)?.text).toMatch(/^Solar flares on/)
    // A new app on the same storage starts as it was left.
    s().toggleFlares()
    const again = await freshStore({ storage })
    expect(again.s().settings.flares).toBe(false)
    expect(again.s().controller.flares).toBe(false)
  })

  it('starts off on a computer that asks for less motion, until it is switched on by hand, and stays as chosen after that', async () => {
    const calm = await freshStore({ reducedMotion: true })
    expect(calm.s().settings.flares).toBe(false)
    expect(calm.s().controller.flares).toBe(false)
    calm.s().toggleFlares()
    expect(calm.s().settings.flares).toBe(true)
    // The choice is stored: the next start keeps it even though the computer still asks for less.
    const next = await freshStore({ storage: calm.storage, reducedMotion: true })
    expect(next.s().settings.flares).toBe(true)
    // A computer that does not ask: on.
    const plain = await freshStore({ reducedMotion: false })
    expect(plain.s().settings.flares).toBe(true)
  })

  it('does not trust what is stored: anything but false is on', async () => {
    const storage = new MemoryStorage()
    storage.setItem('aether:settings', JSON.stringify({ v: 2, flares: 'nope' }))
    const { s } = await freshStore({ storage })
    expect(s().settings.flares).toBe(true)
  })
})

describe('the key and the palette', () => {
  it('Shift+F switches them (Caps Lock or not); plain f still flies to the selection and switches nothing', async () => {
    const { s, press } = await freshStore()
    await s().openVault(vault())
    const flyTo = vi.spyOn(s().controller, 'flyTo').mockImplementation(() => undefined)
    s().select('Work/Plan')
    press('f')
    expect(flyTo).toHaveBeenCalledWith('Work/Plan')
    expect(s().settings.flares).toBe(true)
    press('F', true)
    expect(s().settings.flares).toBe(false)
    press('f', true)
    expect(s().settings.flares).toBe(true)
    expect(flyTo).toHaveBeenCalledTimes(1)
  })

  it('leaves Shift+F to the Boards view, which has its own use of it (fit the selection)', async () => {
    const { s, set, press } = await freshStore()
    await s().openVault(vault())
    set({ view: 'boards' })
    press('F', true)
    expect(s().settings.flares).toBe(true)
  })

  it('is one palette command, with its key, shown while the system layout is', async () => {
    const { s, commands } = await freshStore()
    await s().openVault(vault())
    const cmd = commands.find((c) => c.id === 'flares')!
    expect(cmd.title).toBe('Solar flares: a star that needs attention throws plasma on / off')
    expect(cmd.keys).toBe('Shift+F')
    expect(cmd.when!(s())).toBe(true)
    await cmd.run(s())
    expect(s().settings.flares).toBe(false)
    s().setSettings({ layoutMode: 'orbit' })
    expect(cmd.when!(s())).toBe(false)
  })
})
