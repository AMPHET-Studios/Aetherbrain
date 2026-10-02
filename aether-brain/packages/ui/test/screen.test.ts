import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, folderKey } from '@aether/core'

/** localStorage for the node test environment. */
class MemoryStorage {
  private map = new Map<string, string>()
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

/** A fresh store module (fresh settings, controller and state) and its key handler. */
async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const store = await import('../src/store')
  const { handleKey } = await import('../src/hooks/useKeyboard')
  const press = (key: string, target: Record<string, unknown> = { tagName: 'BODY' }) => {
    const e = {
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: { isContentEditable: false, getAttribute: () => null, hasAttribute: () => false, ...target },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {},
    }
    handleKey(e as unknown as KeyboardEvent)
    return e
  }
  return { s: () => store.useAether.getState(), press }
}

afterEach(() => void vi.unstubAllGlobals())

const STAR = folderKey('Projects/Forge')

describe('a star’s live screen and the keyboard', () => {
  it('Enter opens the app of an open screen unless another node is selected; e never does', async () => {
    const { s, press } = await freshStore()
    await s().openVault(
      new MemoryVaultAdapter([
        { path: 'Projects/Forge.md', content: '---\nstatus: active\n---\n# Forge\n' },
        { path: 'Projects/Forge/Critique/Study.md', content: '# Study\n' },
        { path: 'Inbox/Idea.md', content: '# Idea\n' },
      ]),
    )
    const host = { want: vi.fn(), activate: vi.fn() }
    const c = s().controller
    c.setScreen({ star: STAR, host })

    // Folded away: Enter is Enter.
    press('Enter')
    expect(host.activate).not.toHaveBeenCalled()

    c.screenShown(true)
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(host.activate).toHaveBeenCalledTimes(1)
    // `e` opens the selected note, never the screen.
    press('e')
    expect(host.activate).toHaveBeenCalledTimes(1)

    // The star itself selected: still the screen.
    s().select(STAR)
    press('Enter')
    expect(host.activate).toHaveBeenCalledTimes(2)

    // Another note selected: Enter opens that note.
    s().select('Inbox/Idea')
    press('Enter')
    expect(host.activate).toHaveBeenCalledTimes(2)
    expect(s().editorId).toBe('Inbox/Idea')

    // A focused button keeps its own Enter.
    s().select(null)
    press('Enter', { tagName: 'BUTTON' })
    expect(host.activate).toHaveBeenCalledTimes(2)
  })
})
