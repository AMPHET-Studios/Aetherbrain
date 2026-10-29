import { afterEach, describe, expect, it, vi } from 'vitest'
import { FB_MOON, FB_PLANET, FB_STAR, MemoryVaultAdapter, folderBodies, folderKey, homeKey, isGalaxyNode } from '@aether/core'

/**
 * Icons that do something. The legend's six kinds of body (◉ galaxy, ★ star, ● planet, ◦ moon, · satellite, ▣ sun, 🖼 picture) are chips that light
 * up everything of that kind, like the tag chips; the counts in an inspector (↗ ↙ · ● 🖼) jump to their lists; the logo brings the whole
 * brain back in view. None of them is a picture of a button any more.
 */

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

afterEach(() => {
  vi.unstubAllGlobals()
})

const vault = () =>
  new MemoryVaultAdapter(
    [
      { path: 'Projects/Gate.md', content: '---\nstatus: active\ntags: [gamedev]\n---\n# Gate\n' },
      { path: 'Projects/Gate/Art/Study.md', content: '---\ntags: [gamedev]\n---\n# Study\n\n![[ring.png]]\n\nSee [[Loose]].\n' },
      { path: 'Notes/Loose.md', content: '# Loose\n\nNothing links here, and it links nowhere.\n' },
    ],
    {
      assets: [
        { path: 'Projects/Gate/Art/ring.png', data: new Uint8Array(60_000), mtime: 1 },
        { path: 'Projects/Gate/Art/icon.png', data: new Uint8Array(10), mtime: 1 },
      ],
    },
  )

/** Fresh modules, the vault open, the key handler, and a component as markup from the store's live state. */
async function fresh() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const { handleKey } = await import('../src/hooks/useKeyboard')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const s = () => useAether.getState()
  await s().openVault(vault())
  const html = async (file: string, name: string): Promise<string> => {
    const mod = (await import(`../src/components/${file}.tsx`)) as Record<string, (p: Record<string, unknown>) => React.ReactNode>
    Object.assign(useAether.getInitialState(), useAether.getState())
    return renderToStaticMarkup(createElement(mod[name]!, {}))
  }
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
  return { s, html, press }
}

describe('the legend’s kinds light up what they name', () => {
  it('lights up every picture for 🖼, with nothing else, and stops when pressed again', async () => {
    const { s } = await fresh()
    const pictures = s().graph!.nodes.filter((n) => n.kind === 'image').map((n) => n.id)
    expect(pictures).toHaveLength(2)
    s().toggleBody('picture')
    expect(s().filters.bodies.has('picture')).toBe(true)
    expect(s().controller.highlight).toEqual(new Set(pictures))
    s().toggleBody('picture')
    expect(s().controller.highlight).toBeNull()
  })

  it('lights up every folder by its body: a star, a planet or a moon by depth (a galaxy is a galaxy), and every file for ·', async () => {
    const { s } = await fresh()
    const nodes = s().graph!.nodes
    const kinds = folderBodies(s().graph!)
    const idsOf = (code: number): Set<string> => new Set(nodes.filter((_, i) => kinds[i] === code).map((n) => n.id))
    s().toggleBody('star')
    expect(idsOf(FB_STAR).size).toBeGreaterThan(1)
    expect(s().controller.highlight).toEqual(idsOf(FB_STAR))
    s().toggleBody('star')
    s().toggleBody('planet')
    // Gate is a project, so a star wherever it sits; the folder in it is a planet.
    expect(idsOf(FB_STAR).has(folderKey('Projects/Gate'))).toBe(true)
    expect(idsOf(FB_PLANET).has(folderKey('Projects/Gate/Art'))).toBe(true)
    expect(s().controller.highlight).toEqual(idsOf(FB_PLANET))
    s().toggleBody('planet')
    s().toggleBody('moon')
    // The moons of this vault are the home moons: the one moon each folder's own files orbit.
    expect(idsOf(FB_MOON).size).toBeGreaterThan(0)
    expect(idsOf(FB_MOON).has(homeKey('Projects/Gate/Art'))).toBe(true)
    expect(s().controller.highlight).toEqual(idsOf(FB_MOON))
    s().toggleBody('moon')
    s().toggleBody('galaxy')
    expect(s().controller.highlight).toEqual(new Set(nodes.filter((n) => isGalaxyNode(n)).map((n) => n.id)))
    s().clearFilters()
    // A satellite is any file, big (the 60 KB picture) or small (a note, the 10-byte picture), and no folder.
    s().toggleBody('satellite')
    const big = nodes.find((n) => n.kind === 'image' && (n.image?.size ?? 0) >= 48 * 1024)!
    const lit = s().controller.highlight!
    expect(lit.has(big.id)).toBe(true)
    expect(lit.has('Notes/Loose')).toBe(true)
    expect(lit.has(folderKey('Projects'))).toBe(false)
  })

  it('works with the other filters: a kind and a tag together light up only what is both', async () => {
    const { s } = await fresh()
    s().toggleTag('gamedev')
    s().toggleBody('satellite')
    // The two notes tagged gamedev are satellites; the picture, the folders and the untagged note are not lit.
    expect(s().controller.highlight).toEqual(new Set(['Projects/Gate', 'Projects/Gate/Art/Study']))
    s().toggleBody('satellite')
    s().clearFilters()
    expect(s().controller.highlight).toBeNull()
  })

  it('is cleared by Esc, like the other filters, and by the legend’s own clear button', async () => {
    const { s, press } = await fresh()
    s().toggleBody('star')
    expect(s().controller.highlight).not.toBeNull()
    press('Escape')
    expect(s().filters.bodies.size).toBe(0)
    expect(s().controller.highlight).toBeNull()
  })
})

describe('the legend draws them as chips', () => {
  it('has a chip for each kind that exists, pressed while it is lit, and says what is dimmed', async () => {
    const { s, html } = await fresh()
    const chip = (markup: string, word: string): string => markup.match(new RegExp(`<button[^>]*class="chip[^"]*"[^>]*>[^]*?${word}[^]*?</button>`))?.[0] ?? ''
    const before = await html('Legend', 'Legend')
    for (const word of ['galaxy · drive', 'star · folder', 'planet · sub-folder', 'moon · deeper folder', 'satellite · file', 'picture · 2']) {
      expect(chip(before, word), word).toContain('aria-pressed="false"')
    }
    // No board in this vault, so no sun chip.
    expect(before).not.toContain('sun · board')
    // None of the kinds is a bare span with a tooltip any more.
    expect(before).not.toMatch(/<span title="(A drive|A folder|A picture|Any small file)/)

    s().toggleBody('star')
    const after = await html('Legend', 'Legend')
    expect(chip(after, 'star · folder')).toContain('aria-pressed="true"')
    expect(chip(after, 'satellite · file')).toContain('aria-pressed="false"')
    expect(after).toContain('star · dimming everything else')
  })
})

describe('the counts in an inspector take you to their lists', () => {
  const stat = (markup: string, title: string): string => markup.match(new RegExp(`<button[^>]*title="${title} · jump to the list"[^>]*>[^]*?</button>`))?.[0] ?? ''

  it('jumps from ↗ and ↙ of a note to its lists, and leaves a count of nothing as plain text', async () => {
    const { s, html } = await fresh()
    s().select('Projects/Gate/Art/Study')
    const linked = await html('Inspector', 'Inspector')
    expect(stat(linked, 'Links out')).toContain('↗')
    expect(linked).toContain('data-section="links-out"')
    // Study is linked to by nothing, so its backlinks are a plain number, not a button.
    expect(stat(linked, 'Backlinks')).toBe('')
    expect(linked).toMatch(/<span title="Backlinks">[^]*↙ [^]*0/)

    s().select('Notes/Loose')
    const linkedTo = await html('Inspector', 'Inspector')
    expect(stat(linkedTo, 'Backlinks')).toContain('↙')
    expect(linkedTo).toContain('data-section="backlinks"')
  })

  it('jumps from a folder’s counts to its moons, its folders and its pictures', async () => {
    const { s, html } = await fresh()
    s().select(folderKey('Projects/Gate/Art'))
    const folder = await html('Inspector', 'Inspector')
    expect(stat(folder, 'Notes directly in this folder')).toContain('moon')
    expect(folder).toContain('data-section="moons"')
    expect(stat(folder, 'Pictures directly in this folder · how many orbit it as moons \\(the newest\\)')).toContain('🖼')
    expect(folder).toContain('data-section="pictures"')
  })
})

describe('the logo', () => {
  it('is a button that fits the whole brain in view', async () => {
    const { html } = await fresh()
    const bar = await html('TopBar', 'TopBar')
    const logo = bar.match(/<button[^>]*aria-label="Aether Brain: fit the whole brain in view"[^>]*>/)?.[0] ?? ''
    expect(logo).toContain('title="Fit the whole brain in view (Home)"')
  })
})
