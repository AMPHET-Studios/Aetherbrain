import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BIO_NOTES, MemoryVaultAdapter, type VaultFile } from '@aether/core'
import { lf } from './helpers/lf'

/**
 * The Bio star in the app: the palette's "Create my Bio star" (and the "Make it" on the toast of ⇧ I when there is none) writes
 * the folder `Bio` at the vault's home with a page each for sleep, food, meds, exercise, drugs and mental health, only what is
 * missing and never over anything; ⇧ I flies to the star.
 */

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

async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
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
  /** The inspector as server markup, from the store's live state (server rendering reads the initial state object, so the live one is copied onto it). */
  const inspector = async (): Promise<string> => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Inspector } = await import('../src/components/Inspector')
    Object.assign(store.useAether.getInitialState(), store.useAether.getState())
    return renderToStaticMarkup(createElement(Inspector))
  }
  return { s: () => store.useAether.getState(), subscribe: store.useAether.subscribe, commands: COMMANDS, press, inspector }
}

afterEach(() => void vi.unstubAllGlobals())

const TITLES = BIO_NOTES.map((n) => n.title)
const FILES: VaultFile[] = [
  { path: 'Work/Plan.md', content: '# Plan\n' },
  { path: 'Inbox/idea.md', content: '# Idea\n' },
]
const vault = (o: { readOnly?: boolean; files?: VaultFile[] } = {}) => new MemoryVaultAdapter(o.files ?? FILES, { readOnly: o.readOnly ?? false })

describe('making the Bio star', () => {
  it('writes the six pages under Bio, in one rebuild, and the star appears (blue, named) and the camera goes to it', async () => {
    const { s, subscribe } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    // No Bio folder yet: only the dormant star, standing where it will be, with nothing on disk behind it.
    const dormant = s().graph!.nodes.filter((n) => n.folder?.bio)
    expect(dormant.map((n) => n.id)).toEqual(['folder:Bio'])
    expect(dormant[0]!.folder?.placeholder).toBe(true)
    expect(s().folders.has('Bio')).toBe(false)
    let rebuilds = 0
    const unsub = subscribe((n, p) => {
      if (n.graph !== p.graph) rebuilds++
    })
    const made = await s().makeBio()
    unsub()
    expect(made).toBe(6)
    expect(rebuilds).toBe(1)
    for (const t of TITLES) {
      expect(s().notes.has(`Bio/${t}`), t).toBe(true)
      expect(await adapter.read(`Bio/${t}.md`), t).toContain(`# ${t}`)
    }
    const star = s().graph!.nodes.find((n) => n.id === 'folder:Bio')!
    expect(star.folder?.bio).toBe(true)
    // The same star, made real in place: the same id, no longer dormant.
    expect(star.folder?.placeholder).toBeUndefined()
    expect(star.folder?.notes).toBe(6)
    expect(s().selectedId).toBe('folder:Bio')
    expect(s().toasts.at(-1)).toMatchObject({ text: '✚ Bio star made: 6 pages in Bio', kind: 'success' })
  })

  it('a second time writes nothing and says every page is there', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    await s().makeBio()
    const notes = s().notes.size
    expect(await s().makeBio()).toBe(0)
    expect(s().notes.size).toBe(notes)
    expect(s().toasts.at(-1)?.text).toBe('The Bio star is complete: every page is there')
  })

  it('never touches a page he wrote in, and brings back one that was deleted', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    await s().makeBio()
    await adapter.write('Bio/Food.md', 'My own food notes, the way I like them.\n')
    await adapter.remove('Bio/Meds.md')
    expect(await s().makeBio()).toBe(1)
    expect(await adapter.read('Bio/Food.md')).toBe('My own food notes, the way I like them.\n')
    expect(await adapter.read('Bio/Meds.md')).toContain('# Meds')
    expect(s().toasts.at(-1)?.text).toBe('✚ Bio star: added 1 page (5 were already there)')
  })

  it('leaves alone a page that is on disk but that the brain has not heard about yet, and makes no numbered copy of it', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    // A file written behind the brain's back (no change was reported): the plan thinks Food is missing, the disk says otherwise.
    ;(adapter as unknown as { files: Map<string, VaultFile> }).files.set('Bio/Food.md', { path: 'Bio/Food.md', content: 'written elsewhere\n', mtime: 1 })
    expect(s().notes.has('Bio/Food')).toBe(false)
    expect(await s().makeBio()).toBe(5)
    expect(await adapter.read('Bio/Food.md')).toBe('written elsewhere\n')
    expect(await adapter.read('Bio/Food 2.md')).toBeNull()
    expect(s().toasts.at(-1)?.text).toBe('✚ Bio star: added 5 pages (1 was already there)')
  })

  it('uses the folder and the pages as the vault already spells them (bio is Bio on Windows), writing no second copy', async () => {
    const { s } = await freshStore()
    const adapter = vault({ files: [...FILES, { path: 'bio/food.md', content: 'mine\n' }] })
    await s().openVault(adapter)
    // The folder exists under its own spelling, so it is already the Bio star.
    expect(s().graph!.nodes.find((n) => n.id === 'folder:bio')?.folder?.bio).toBe(true)
    expect(await s().makeBio()).toBe(5)
    expect(await adapter.read('bio/food.md')).toBe('mine\n')
    expect(s().notes.has('bio/Sleep schedule')).toBe(true)
    expect([...s().notes.keys()].filter((k) => k.startsWith('Bio/'))).toEqual([])
    expect(s().toasts.at(-1)?.text).toBe('✚ Bio star: added 5 pages (1 was already there)')
  })

  it('goes under the first drive of a vault with several roots', async () => {
    const { s } = await freshStore()
    const adapter = new MemoryVaultAdapter([
      { path: 'D/Work/Plan.md', content: '# Plan\n' },
      { path: 'F/Art/Study.md', content: '# Study\n' },
    ])
    Object.assign(adapter, {
      roots: [
        { path: 'D:\\', mount: 'D', label: 'D:\\' },
        { path: 'F:\\', mount: 'F', label: 'F:\\' },
      ],
    })
    await s().openVault(adapter)
    expect(await s().makeBio()).toBe(6)
    expect(s().notes.has('D/Bio/Food')).toBe(true)
    expect([...s().notes.keys()].some((k) => k.startsWith('F/Bio'))).toBe(false)
    expect(s().graph!.nodes.find((n) => n.id === 'folder:D/Bio')?.folder?.bio).toBe(true)
  })

  it('writes nothing in a read-only vault', async () => {
    const { s } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    const notes = s().notes.size
    expect(await s().makeBio()).toBe(0)
    expect(s().notes.size).toBe(notes)
    expect(s().toasts.at(-1)).toMatchObject({ text: 'This vault is read-only', kind: 'error' })
  })

  it('says so when no vault is open', async () => {
    const { s } = await freshStore()
    expect(await s().makeBio()).toBe(0)
    expect(s().toasts.at(-1)).toMatchObject({ text: 'Open a vault first to make the Bio star', kind: 'error' })
  })
})

describe('going to the Bio star', () => {
  it('selects the star when the vault has one', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    await s().makeBio()
    s().select(null)
    s().goToBio()
    expect(s().selectedId).toBe('folder:Bio')
  })

  it('with none yet, flies to the dormant star, whose card offers to make it; nothing is written', async () => {
    const { s, inspector } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    s().goToBio()
    expect(s().selectedId).toBe('folder:Bio')
    expect(s().toasts.at(-1)?.text).not.toBe('No Bio star yet')
    expect(await adapter.read('Bio/Food.md')).toBeNull()
    expect(s().notes.has('Bio/Food')).toBe(false)
    expect(await inspector()).toContain('Make my Bio star')
  })

  it('in a layout without folders there is no star to fly to: says so and offers to make it; the toast’s action (the u key) makes it', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().setSettings({ layoutMode: 'constellation' })
    expect(s().graph!.nodes.some((n) => n.folder?.bio)).toBe(false)
    s().goToBio()
    expect(s().toasts.at(-1)).toMatchObject({ text: 'No Bio star yet' })
    expect(s().toasts.at(-1)?.action?.label).toBe('Make it')
    expect(s().notes.has('Bio/Food')).toBe(false)
    expect(s().toastAction()).toBe(true)
    await vi.waitFor(() => expect(s().notes.has('Bio/Food')).toBe(true))
    expect(s().selectedId).toBe('folder:Bio')
  })

  it('offers nothing to make in a read-only vault', async () => {
    const { s } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    s().goToBio()
    expect(s().toasts.at(-1)?.text).toBe('No Bio star yet')
    expect(s().toasts.at(-1)?.action).toBeUndefined()
  })
})

describe('the palette and the key', () => {
  it('offers Create my Bio star where the vault can be written, and a way to fly there with ⇧ I', async () => {
    const { s, commands } = await freshStore()
    const make = commands.find((c) => c.id === 'bio-make')!
    const go = commands.find((c) => c.id === 'bio-go')!
    expect(make.title).toBe('Create my Bio star (sleep, food, meds, exercise, drugs, mental health)')
    expect(go.keys).toBe('⇧ I')
    expect(go.group).toBe('navigate')
    await s().openVault(vault())
    expect(make.when!(s())).toBe(true)
    await make.run(s())
    expect(s().notes.has('Bio/Mental health')).toBe(true)
  })

  it('hides the command in a read-only vault', async () => {
    const { s, commands } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    expect(commands.find((c) => c.id === 'bio-make')!.when!(s())).toBe(false)
  })

  it('⇧ I goes to the Bio star (Caps Lock or not), and the plain i stays the AI chat import', async () => {
    const { s, press } = await freshStore()
    // Read-only, so the plain i has nothing to open a dialog for: it does nothing here, and must not reach the Bio star.
    await s().openVault(vault({ readOnly: true }))
    const toasts = s().toasts.length
    press('i')
    press('I')
    expect(s().toasts.length).toBe(toasts)
    press('I', true)
    expect(s().toasts.at(-1)?.text).toBe('No Bio star yet')
    const after = s().toasts.length
    press('i', true)
    expect(s().toasts.length).toBe(after + 1)
  })
})

describe('the Bio star’s inspector', () => {
  it('says what lives there and who could see it, and has nothing to add once every page is there', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault())
    await s().makeBio()
    expect(s().selectedId).toBe('folder:Bio')
    const out = await inspector()
    expect(out).toContain('✚ Bio star')
    expect(out).toContain('Your notes on sleep, food, meds, exercise, drugs and mental health live here.')
    expect(out).toContain('They stay on this computer. If you chat with Claude, what the chat reads from them goes to Anthropic; with Ollama nothing leaves.')
    expect(out).not.toContain('missing')
    // It is a star of its own: not something to turn into a project.
    expect(out).not.toContain('Make project')
  })

  it('offers to add just the pages that are missing', async () => {
    const { s, inspector } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    await s().makeBio()
    await adapter.remove('Bio/Meds.md')
    expect(await inspector()).toContain('✚ Add the 1 missing page<')
    await adapter.remove('Bio/Drugs.md')
    expect(await inspector()).toContain('✚ Add the 2 missing pages<')
  })

  it('does not offer to write in a read-only vault', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault({ readOnly: true, files: [...FILES, { path: 'Bio/Food.md', content: '# Food\n' }] }))
    s().select('folder:Bio')
    const out = await inspector()
    expect(out).toContain('✚ Bio star')
    expect(out).not.toContain('missing')
  })

  it('is not on any other folder', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault())
    await s().makeBio()
    s().select('folder:Work')
    const out = await inspector()
    expect(out).toContain('Star · folder')
    expect(out).not.toContain('Bio star')
    expect(out).toContain('Make project')
  })
})

describe('the dormant Bio star: seen before it is made', () => {
  it('stands in a writable vault that has no Bio folder, and drawing it writes nothing', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    const star = s().graph!.nodes.find((n) => n.id === 'folder:Bio')
    expect(star?.folder).toMatchObject({ bio: true, placeholder: true, notes: 0, totalNotes: 0, role: 'folder' })
    // It hangs from the vault's galaxy like any folder directly under it.
    expect(star?.parent).toBe('folder:')
    expect(s().folders.has('Bio')).toBe(false)
    expect([...s().notes.keys()].some((k) => k.startsWith('Bio/'))).toBe(false)
    expect(await adapter.read('Bio/Food.md')).toBeNull()
  })

  it('is not there in a read-only vault: there is nothing to make it with', async () => {
    const { s } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    expect(s().graph!.nodes.some((n) => n.folder?.bio)).toBe(false)
  })

  it('is one star, never two: a vault that has the folder gets the real one only', async () => {
    const { s } = await freshStore()
    await s().openVault(vault({ files: [...FILES, { path: 'Bio/Food.md', content: '# Food\n' }] }))
    const stars = s().graph!.nodes.filter((n) => n.folder?.bio)
    expect(stars.map((n) => n.id)).toEqual(['folder:Bio'])
    expect(stars[0]!.folder?.placeholder).toBeUndefined()
  })

  it('has a card that says it is waiting and offers one button, with no folder actions to take on disk', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault())
    s().select('folder:Bio')
    const out = await inspector()
    expect(out).toContain('✚ Bio star · not made yet')
    expect(out).toContain('Your Bio star is waiting.')
    expect(out).toContain('Nothing is written until you press the button.')
    expect(out).toContain('✚ Make my Bio star')
    expect(out).toContain('Bio/ · not on disk yet')
    // Nothing on disk yet: no notes or folders to add, no counts to show, not something to turn into a project.
    expect(out).not.toContain('Note here')
    expect(out).not.toContain('Folder here')
    expect(out).not.toContain('Make project')
    expect(out).not.toContain('notes in all')
  })

  it('has nothing to open: it is not a sun itself, so the sun bar stays away and the s key turns its galaxy, not it', async () => {
    const { s } = await freshStore()
    const { sunTargetOf } = await import('../src/commands')
    await s().openVault(vault())
    s().select('folder:Bio')
    // The sun of a body is the one it orbits: the vault's galaxy.
    expect(sunTargetOf(s())).toBe('folder:')
    const node = s().graph!.nodes.find((n) => n.id === 'folder:Bio')!
    const { isSunNode } = await import('@aether/core')
    expect(isSunNode(node)).toBe(false)
  })

  it('becomes the real star when it is made: the same id and the same selection', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault())
    s().select('folder:Bio')
    expect(await s().makeBio()).toBe(6)
    expect(s().selectedId).toBe('folder:Bio')
    const out = await inspector()
    expect(out).toContain('✚ Bio star<')
    expect(out).not.toContain('not made yet')
    expect(out).toContain('Note here')
  })
})

describe('the guides', () => {
  const guide = (p: string) => lf(readFileSync(new URL(`../../../docs/${p}`, import.meta.url), 'utf8'))

  it('say what the Bio star is, where it goes and who could see it', () => {
    const cosmology = guide('COSMOLOGY.md')
    expect(cosmology).toContain('## The Bio black hole')
    expect(cosmology).toContain('every galaxy revolves around it')
    expect(cosmology).toContain('Sleep schedule')
    expect(cosmology).toContain('`Bio` folder')
    expect(cosmology).toContain('a page that is there, under any letter case, is never touched')
    expect(guide('KEYBOARD.md')).toContain('`⇧ I`')
    expect(guide('BRAIN-CHAT.md')).toContain('## Your Bio notes')
    expect(guide('BRAIN-CHAT.md')).toContain('goes to Anthropic')
  })
})
