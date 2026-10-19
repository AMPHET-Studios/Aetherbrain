import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'

/**
 * When an AI writes through the link the brain flies to what it touched (`flyToPath`, from the activity of the call): a note, a
 * folder it made, and now a picture it sent (save_image), which used to be looked up as a folder and never found.
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

async function fresh() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether } = await import('@aether/ui')
  const { flyToPath } = await import('../src/renderer/panels')
  await useAether.getState().openVault(
    new MemoryVaultAdapter(
      [
        { path: 'Inbox/A gate that hums.md', content: '# A gate that hums\n\n![[Inbox/Pictures/gate-hum.png]]\n\nIt hums.\n' },
        { path: 'Projects/PORTALz.md', content: '# PORTALz\n' },
      ],
      { folders: ['Projects/PORTALz/Sound'], assets: [{ path: 'Inbox/Pictures/gate-hum.png', data: new Uint8Array(10), mtime: 1 }] },
    ),
  )
  return { s: () => useAether.getState(), flyToPath }
}

afterEach(() => void vi.unstubAllGlobals())

describe('the brain flies to what an AI wrote', () => {
  it('a note, by its path', async () => {
    const { s, flyToPath } = await fresh()
    s().select(null)
    flyToPath('Inbox/A gate that hums.md')
    expect(s().selectedId).toBe('Inbox/A gate that hums')
  })

  it('a picture an AI sent, by its path (it used to be looked up as a folder and never found)', async () => {
    const { s, flyToPath } = await fresh()
    s().select(null)
    flyToPath('Inbox/Pictures/gate-hum.png')
    expect(s().selectedId).toBe('image:Inbox/Pictures/gate-hum.png')
  })

  it('a folder it made, by its path', async () => {
    const { s, flyToPath } = await fresh()
    s().select(null)
    flyToPath('Projects/PORTALz/Sound')
    expect(s().selectedId).toBe('folder:Projects/PORTALz/Sound')
  })
})
