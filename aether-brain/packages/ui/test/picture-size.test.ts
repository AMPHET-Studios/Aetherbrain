import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'

/** localStorage for the node test environment. */
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
  const { handleKey } = await import('../src/hooks/useKeyboard')
  const press = (key: string) =>
    handleKey({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: { tagName: 'BODY', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false },
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyboardEvent)
  return { s: () => store.useAether.getState(), commands: COMMANDS, press, storage }
}

afterEach(() => void vi.unstubAllGlobals())

const vault = () =>
  new MemoryVaultAdapter(
    [
      { path: 'Projects/Gate.md', content: '---\nstatus: active\n---\n# Gate\n' },
      { path: 'Projects/Gate/Art/Study.md', content: '# Study\n' },
    ],
    { assets: [{ path: 'Projects/Gate/Art/ring.png', data: new Uint8Array(10), mtime: 1 }] },
  )

describe('picture sizes in the app', () => {
  it('start extra large, cycle with z (extra large → medium → large), rebuild the graph and stay chosen', async () => {
    const { s, press, storage } = await freshStore()
    // The big files are planets drawn as extra-large thumbnails: that is where it starts.
    expect(s().settings.pictureSize).toBe('xl')
    expect(s().controller.pictureSize).toBe('xl')
    await s().openVault(vault())
    const before = s().graph
    press('z')
    expect(s().settings.pictureSize).toBe('medium')
    expect(s().controller.pictureSize).toBe('medium')
    expect(s().controller.engine.pictureSize).toBe('medium')
    // The layout spaces orbits by the size: a new graph went to the layout.
    expect(s().graph).not.toBe(before)
    expect(s().toasts.at(-1)?.text).toMatch(/medium icons/)
    press('z')
    expect(s().settings.pictureSize).toBe('large')
    press('z')
    expect(s().settings.pictureSize).toBe('xl')
    // Kept for next time.
    expect(JSON.parse(storage.getItem('aether:settings') ?? '{}').pictureSize).toBe('xl')
  })

  it('has a palette command per size, and ignores a size it does not know', async () => {
    const storage = new MemoryStorage()
    storage.setItem('aether:settings', JSON.stringify({ pictureSize: 'huge', v: 2 }))
    const { s, commands } = await freshStore(storage)
    expect(s().settings.pictureSize).toBe('xl')
    const large = commands.find((c) => c.id === 'picture-size-large')!
    expect(large.title).toMatch(/large icons/)
    await large.run(s())
    expect(s().settings.pictureSize).toBe('large')
    expect(commands.find((c) => c.id === 'picture-size')?.keys).toBe('z')
    s().setSettings({ pictureSize: 'giant' as never })
    expect(s().settings.pictureSize).toBe('large')
  })
})
