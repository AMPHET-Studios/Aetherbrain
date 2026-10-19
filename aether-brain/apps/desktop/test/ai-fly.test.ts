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
  const { flyToPath, showForAi, reportTunnel } = await import('../src/renderer/panels')
  await useAether.getState().openVault(
    new MemoryVaultAdapter(
      [
        { path: 'Inbox/A gate that hums.md', content: '# A gate that hums\n\n![[Inbox/Pictures/gate-hum.png]]\n\nIt hums.\n' },
        { path: 'Projects/PORTALz.md', content: '# PORTALz\n' },
      ],
      { folders: ['Projects/PORTALz/Sound'], assets: [{ path: 'Inbox/Pictures/gate-hum.png', data: new Uint8Array(10), mtime: 1 }] },
    ),
  )
  return { s: () => useAether.getState(), set: useAether.setState, flyToPath, showForAi, reportTunnel }
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

describe('an AI asks the window to show something (show_in_brain)', () => {
  it('flies to a note and selects it, without opening it unless asked', async () => {
    const { s, showForAi } = await fresh()
    s().select(null)
    showForAi({ kind: 'note', path: 'Projects/PORTALz.md', open: false })
    expect(s().selectedId).toBe('Projects/PORTALz')
    expect(s().editorId).toBeNull()
  })

  it('opens a note in the editor when asked to', async () => {
    const { s, showForAi } = await fresh()
    s().select(null)
    showForAi({ kind: 'note', path: 'Projects/PORTALz.md', open: true })
    expect(s().selectedId).toBe('Projects/PORTALz')
    expect(s().editorId).toBe('Projects/PORTALz')
    expect(s().view).toBe('editor')
  })

  it('shows a folder as its star, a picture as its moon and the Today hub', async () => {
    const { s, showForAi } = await fresh()
    s().select(null)
    showForAi({ kind: 'folder', path: 'Projects/PORTALz/Sound', open: false })
    expect(s().selectedId).toBe('folder:Projects/PORTALz/Sound')
    showForAi({ kind: 'picture', path: 'Inbox/Pictures/gate-hum.png', open: false })
    expect(s().selectedId).toBe('image:Inbox/Pictures/gate-hum.png')
    // Looking at a picture must not open the picture app: that is what Enter does, not what an AI's "show" does.
    showForAi({ kind: 'today', path: '', open: false })
    expect(s().selectedId).toBe('today:')
  })

  it('leaves the camera alone while a note is being typed, and says so', async () => {
    const { s, set, showForAi } = await fresh()
    s().openNote('Projects/PORTALz')
    set({ dirty: true })
    showForAi({ kind: 'folder', path: 'Projects/PORTALz/Sound', open: false })
    expect(s().selectedId).toBe('Projects/PORTALz')
    expect(s().toasts.at(-1)?.text).toBe('An AI wants to show you Sound. Save your note, then ask again.')
    showForAi({ kind: 'today', path: '', open: false })
    expect(s().selectedId).toBe('Projects/PORTALz')
    expect(s().toasts.at(-1)?.text).toBe('An AI wants to show you the Today hub. Save your note, then ask again.')
  })

  it('does nothing before a vault is ready', async () => {
    const { s, set, showForAi } = await fresh()
    s().select(null)
    set({ status: 'idle' })
    showForAi({ kind: 'note', path: 'Projects/PORTALz.md', open: true })
    expect(s().selectedId).toBeNull()
    expect(s().editorId).toBeNull()
  })
})

describe('the tunnel says what it did', () => {
  const tunnel = (state: 'off' | 'starting' | 'on', error: string | null = null) => ({ state, url: state === 'on' ? 'https://quiet-river-test.trycloudflare.com' : null, error, program: 'path' as const, download: null, downloading: null })

  it('says when it opens the brain to the internet, once, and when it ends', async () => {
    const { s, reportTunnel } = await fresh()
    const before = s().toasts.length
    reportTunnel(tunnel('starting'))
    expect(s().toasts.length).toBe(before)
    reportTunnel(tunnel('on'))
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'info', text: 'Tunnel on: ChatGPT and claude.ai can reach your brain. Stop it in the AI link panel (a).' })
    const afterOn = s().toasts.length
    reportTunnel(tunnel('on'))
    expect(s().toasts.length).toBe(afterOn)
    reportTunnel(tunnel('off'))
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'info', text: 'Tunnel stopped' })
  })

  it('says why when it ended by itself', async () => {
    const { s, reportTunnel } = await fresh()
    reportTunnel(tunnel('on'))
    reportTunnel(tunnel('off', 'cloudflared stopped (exit code 1): ERR connection reset'))
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'cloudflared stopped (exit code 1): ERR connection reset' })
  })

  it('says nothing for an off that was never an on (the panel just looked, or a start failed)', async () => {
    const { s, reportTunnel } = await fresh()
    const before = s().toasts.length
    reportTunnel(tunnel('off'))
    reportTunnel(tunnel('off', 'cloudflared is not on this computer yet'))
    expect(s().toasts.length).toBe(before)
  })

  it('says it again for a second tunnel after the first one ended', async () => {
    const { s, reportTunnel } = await fresh()
    reportTunnel(tunnel('on'))
    reportTunnel(tunnel('off'))
    const n = s().toasts.length
    reportTunnel(tunnel('on'))
    expect(s().toasts.length).toBe(n + 1)
  })
})
