import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, folderKey, imageKey, type VaultFile } from '@aether/core'
import { GALLERY_DWELL_MS, GALLERY_FOLD_MS } from '@aether/graph'

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

/** A fresh store module (fresh settings, controller and state), its commands and key handler. */
async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
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
      shiftKey: key !== key.toLowerCase(),
      target: { tagName: 'BODY', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false },
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyboardEvent)
  return { s: () => store.useAether.getState(), store, commands: COMMANDS, press }
}

/** Open the test vault (real timers: loading yields to the event loop), then fake the clock for the folds. */
async function openVault(s: () => { openVault(a: MemoryVaultAdapter): Promise<void> }) {
  vi.useRealTimers()
  await s().openVault(vault())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 255)
const STAR = folderKey('Projects/Gate')

function project(title: string): string {
  return `---\ntitle: ${title}\ntype: project\nstatus: active\n---\n# ${title}\n\n## To do\n\n- [ ] First step\n`
}

const notes = (): VaultFile[] => [
  { path: 'Projects/Gate.md', content: project('Gate') },
  { path: 'Projects/Gate/Art/Study.md', content: '# Study\n\n![[ring.png]]\n' },
  { path: 'Projects/Quiet.md', content: project('Quiet') },
  { path: 'Projects/Quiet/Notes/Plan.md', content: '# Plan\n' },
  { path: 'Inbox/Idea.md', content: '# Idea\n' },
]
/** 30 pictures in Art (more than a folder's 24 moons), 2 deep below it, 1 elsewhere. */
const pictures = () => [
  ...Array.from({ length: 30 }, (_, i) => ({ path: `Projects/Gate/Art/sketch ${String(i).padStart(2, '0')}.png`, data: bytes(10), mtime: 100 + i })),
  { path: 'Projects/Gate/Art/ring.png', data: bytes(10), mtime: 1 },
  { path: 'Projects/Gate/Art/Old/Deeper/first.png', data: bytes(10), mtime: 0 },
  { path: 'Resources/tree.png', data: bytes(10), mtime: 50 },
]
const vault = () => new MemoryVaultAdapter(notes(), { assets: pictures(), folders: ['Projects/Gate/Art/Old/Deeper', 'Resources'] })

describe('star galleries in the app', () => {
  it('opens when the camera comes close to a star, with every picture under it, and folds when it leaves', async () => {
    const { s } = await freshStore()
    await openVault(s)
    const before = s().graph!.nodes.length
    expect(s().graph!.gallery).toBeNull()

    s().controller.nearStar(STAR)

    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().gallery).toBe('Projects/Gate')
    const g = s().graph!
    expect(g.gallery).toEqual({ star: STAR, path: 'Projects/Gate', cards: 32, total: 32 })
    expect(g.nodes.filter((n) => n.image?.gallery?.star === STAR)).toHaveLength(32)
    expect(g.index.has(imageKey('Projects/Gate/Art/Old/Deeper/first.png'))).toBe(true)
    expect(g.nodes.find((n) => n.id === imageKey('Resources/tree.png'))?.image?.gallery).toBeUndefined()
    // The first gallery of a session says how it works; later ones open quietly.
    expect(s().toasts.at(-1)?.text).toBe('★ Gate: 32 pictures in 3D around the star · Shift+G folds them')

    // An edit while it is open keeps it open.
    s().applyExternal([{ kind: 'add', path: 'Projects/Gate/new.png', mtime: 999, size: 10 }])
    expect(s().graph!.gallery).toMatchObject({ cards: 33 })

    s().controller.nearStar(null)
    expect(s().controller.galleryFold).toBeGreaterThanOrEqual(0)
    expect(s().gallery).toBe('Projects/Gate')
    vi.advanceTimersByTime(GALLERY_FOLD_MS)
    expect(s().gallery).toBeNull()
    expect(s().graph!.gallery).toBeNull()
    expect(s().graph!.nodes.length).toBe(before + 1)
    const toasts = s().toasts.length
    s().controller.nearStar(STAR)
    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().graph!.gallery).not.toBeNull()
    expect(s().toasts.length).toBe(toasts)
  })

  it('Shift+G opens the gallery of the selection’s star and flies there; again folds it', async () => {
    const { s, press } = await freshStore()
    await openVault(s)
    s().select('Projects/Gate/Art/Study')
    press('G')
    expect(s().gallery).toBe('Projects/Gate')
    expect(s().selectedId).toBe(STAR)
    expect(s().toasts.at(-1)?.text).toBe('★ Gate: 32 pictures in 3D · Shift+G folds them')
    // A card of the open gallery belongs to its star: Shift+G folds it.
    s().select(imageKey('Projects/Gate/Art/Old/Deeper/first.png'))
    press('G')
    vi.advanceTimersByTime(GALLERY_FOLD_MS)
    expect(s().gallery).toBeNull()
    // The card is gone with the gallery, and so is the selection.
    expect(s().selectedId).toBeNull()
  })

  it('Shift decides with Caps Lock on; Tab from a star reaches its planets before the gallery cards', async () => {
    const { s, store } = await freshStore()
    await openVault(s)
    const { handleKey } = await import('../src/hooks/useKeyboard')
    const key = (k: string, shiftKey: boolean) =>
      handleKey({
        key: k,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey,
        target: { tagName: 'BODY', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false },
        preventDefault() {},
        stopPropagation() {},
      } as unknown as KeyboardEvent)
    s().select(STAR)
    key('G', false) // Caps Lock, plain g: not the gallery
    expect(s().gallery).toBeNull()
    key('g', true) // Caps Lock, Shift+G
    expect(s().gallery).toBe('Projects/Gate')
    s().select(STAR)
    s().cycleNeighbor(1)
    s().cycleNeighbor(1)
    const g = s().graph!
    expect(g.nodes[g.index.get(s().hoveredId!)!]!.image?.gallery?.only).not.toBe(true)
    s().cycleNeighbor(-1)
    s().cycleNeighbor(-1)
    s().cycleNeighbor(-1)
    expect(g.nodes[g.index.get(s().hoveredId!)!]!.image?.gallery?.only).toBe(true)
    expect(store.starOf(g, s().hoveredId)).toBe(STAR)
  })

  it('explains what Shift+G needs instead of doing nothing', async () => {
    const { s, press } = await freshStore()
    await openVault(s)
    press('G')
    expect(s().toasts.at(-1)?.text).toBe('Select a project star (★) first, or fly close to one')
    s().select(folderKey('Projects/Quiet'))
    press('G')
    expect(s().toasts.at(-1)?.text).toBe('No pictures under ★ Quiet yet: drop some on the window')
    expect(s().gallery).toBeNull()
    // Close to a star without pictures: nothing to show, nothing rebuilt.
    const graph = s().graph
    s().controller.nearStar(folderKey('Projects/Quiet'))
    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().graph).toBe(graph)
    s().setSettings({ layoutMode: 'constellation' })
    press('G')
    expect(s().toasts.at(-1)?.text).toBe('Star galleries live in the system layout: press t to get there')
  })

  it('the setting turns the fly-close opening off; leaving the system layout or the vault lets the gallery go', async () => {
    const { s, commands } = await freshStore()
    await openVault(s)
    commands.find((c) => c.id === 'star-galleries')!.run(s())
    expect(s().settings.starGalleries).toBe(false)
    expect(JSON.parse(localStorage.getItem('aether:settings')!).starGalleries).toBe(false)
    s().controller.nearStar(STAR)
    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().gallery).toBeNull()
    commands.find((c) => c.id === 'star-galleries')!.run(s())
    s().controller.nearStar(null)
    s().controller.nearStar(STAR)
    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().gallery).toBe('Projects/Gate')

    s().setSettings({ layoutMode: 'orbit' })
    expect(s().gallery).toBeNull()
    expect(s().graph!.gallery).toBeNull()
    expect(commands.find((c) => c.id === 'gallery')!.when!(s())).toBe(false)
    s().setSettings({ layoutMode: 'system' })
    expect(s().graph!.gallery).toBeNull()

    s().controller.nearStar(null)
    s().controller.nearStar(STAR)
    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().gallery).toBe('Projects/Gate')
    await openVault(s)
    expect(s().gallery).toBeNull()
    expect(s().graph!.gallery).toBeNull()
    // The new vault's controller state starts clean: coming close opens again.
    s().controller.nearStar(STAR)
    vi.advanceTimersByTime(GALLERY_DWELL_MS)
    expect(s().gallery).toBe('Projects/Gate')
  })

  it('counts pictures under a folder and finds the star of a node', async () => {
    const { s, store } = await freshStore()
    await openVault(s)
    expect(store.picturesUnder(s().assets, 'Projects/Gate')).toBe(32)
    expect(store.picturesUnder(s().assets, 'Projects/Gat')).toBe(0)
    const g = s().graph
    expect(store.starOf(g, 'Projects/Gate')).toBe(STAR)
    expect(store.starOf(g, folderKey('Projects/Gate/Art'))).toBe(STAR)
    expect(store.starOf(g, 'Inbox/Idea')).toBeNull()
    expect(store.starOf(g, null)).toBeNull()
    expect(store.starOf(null, 'Projects/Gate')).toBeNull()
  })
})
