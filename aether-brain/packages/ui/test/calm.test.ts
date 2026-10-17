import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'
import { CALM_MAX_SPEED, calmSpeed, urgencySpeed } from '@aether/graph'
import { lf } from './helpers/lf'

/**
 * Calm mode in the app (docs/COSMOLOGY.md, "Calm mode"): the setting, its key, its palette command, its legend switch, the
 * cheatsheet row, and the numbers the documents state. What the orbits then do is pinned in the graph package
 * (`calm.test.ts`, and the worker's calm tests).
 */

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

/** Fresh store, key handler and commands (fresh settings and state), with `stored` as the saved settings. */
async function fresh(stored?: unknown) {
  const storage = new MemoryStorage()
  if (stored !== undefined) storage.setItem('aether:settings', typeof stored === 'string' ? stored : JSON.stringify(stored))
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const { handleKey } = await import('../src/hooks/useKeyboard')
  const { findCommands } = await import('../src/commands')
  const s = () => useAether.getState()
  /** A keydown as the global handler sees it; `typing` focuses a text field. */
  const press = (key: string, opts: { shift?: boolean; typing?: boolean } = {}) =>
    handleKey({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: !!opts.shift,
      target: { tagName: opts.typing ? 'INPUT' : 'BODY', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false },
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyboardEvent)
  return { useAether, s, press, findCommands, storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('calm mode: the setting', () => {
  it('is off until asked for, reaches the controller, and is remembered', async () => {
    const first = await fresh()
    expect(first.s().settings.calm).toBe(false)
    expect(first.s().controller.calm).toBe(false)

    first.s().toggleCalm()
    expect(first.s().settings.calm).toBe(true)
    expect(first.s().controller.calm).toBe(true)
    // The engine (and through it the layout worker) was told too.
    expect(first.s().controller.engine.calm).toBe(true)
    expect(first.s().toasts.at(-1)?.text).toMatch(/Calm orbits/)

    const second = await fresh(first.storage.getItem('aether:settings')!)
    expect(second.s().settings.calm).toBe(true)
    expect(second.s().controller.calm).toBe(true)

    second.s().toggleCalm()
    expect(second.s().settings.calm).toBe(false)
    expect(second.s().controller.engine.calm).toBe(false)
    expect(second.s().toasts.at(-1)?.text).toMatch(/urgent speed/)
  })

  it('takes only a saved true as calm: settings written before it, or by hand, mean off', async () => {
    for (const stored of [{ colorMode: 'type' }, { calm: 'yes' }, { calm: 1 }, { calm: null }, { calm: false }]) {
      expect((await fresh(stored)).s().settings.calm, JSON.stringify(stored)).toBe(false)
    }
    expect((await fresh({ calm: true })).s().settings.calm).toBe(true)
  })
})

describe('calm mode: the keyboard', () => {
  it('is Shift+O, and plain o still pauses the orbits', async () => {
    const { s, press } = await fresh()
    press('O', { shift: true })
    expect(s().settings.calm).toBe(true)
    expect(s().settings.motion).toBe(true)

    press('o')
    expect(s().settings.motion).toBe(false)
    expect(s().settings.calm).toBe(true)

    press('O', { shift: true })
    expect(s().settings.calm).toBe(false)
    press('o')
    expect(s().settings.motion).toBe(true)
  })

  it('goes by the Shift key, not the letter case: with Caps Lock on, o arrives as O and Shift+O as o', async () => {
    const { s, press } = await fresh()
    press('O')
    expect(s().settings.motion).toBe(false)
    expect(s().settings.calm).toBe(false)
    press('o', { shift: true })
    expect(s().settings.calm).toBe(true)
    expect(s().settings.motion).toBe(false)
  })

  it('leaves the key to a text field', async () => {
    const { s, press } = await fresh()
    press('O', { shift: true, typing: true })
    press('o', { typing: true })
    expect(s().settings.calm).toBe(false)
    expect(s().settings.motion).toBe(true)
  })
})

describe('calm mode: the palette, the legend and the cheatsheet', () => {
  it('has a palette command with its key and a hint that runs the toggle', async () => {
    const { s, findCommands } = await fresh()
    const cmd = findCommands('calm', s()).find((c) => c.id === 'calm')
    expect(cmd).toBeDefined()
    expect(cmd!.keys).toBe('Shift+O')
    expect(cmd!.hint).toMatch(/faster than a normal one/)
    await cmd!.run(s())
    expect(s().settings.calm).toBe(true)
    // The motion command is a different one, and still there.
    expect(findCommands('', s()).some((c) => c.id === 'motion' && c.keys === 'o')).toBe(true)
  })

  /** A component as markup, rendered from the store's live state (see the same helper in v04-view.test.ts). */
  async function renderer() {
    const env = await fresh()
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const html = async (file: string, name: string) => {
      const mod = (await import(`../src/components/${file}.tsx`)) as Record<string, (p: Record<string, unknown>) => React.ReactNode>
      Object.assign(env.useAether.getInitialState(), env.useAether.getState())
      return renderToStaticMarkup(createElement(mod[name]!, {}))
    }
    return { ...env, html }
  }

  it('shows a ☾ calm switch in the legend beside the orbit switch, pressed when calm is on', async () => {
    const { s, html } = await renderer()
    await s().openVault(new MemoryVaultAdapter([{ path: 'Notes/a.md', content: '# a\n' }]))
    const button = (markup: string): string => markup.match(/<button[^>]*>☾ calm<\/button>/)?.[0] ?? ''
    const off = await html('Legend', 'Legend')
    expect(off).toContain('↻ orbiting')
    expect(button(off)).toContain('aria-pressed="false"')
    expect(button(off)).toContain('⇧O')

    s().toggleCalm()
    expect(button(await html('Legend', 'Legend'))).toContain('aria-pressed="true"')
  })

  it('is on the cheatsheet', async () => {
    const { s, html } = await renderer()
    s().setHelp(true)
    const help = await html('Help', 'Help')
    expect(help).toContain('⇧ O')
    expect(help).toContain('Calm orbits on / off')
  })
})

describe('calm mode: the documents', () => {
  const root = (p: string) => new URL(`../../../${p}`, import.meta.url)
  const read = (p: string) => lf(readFileSync(root(p), 'utf8'))

  it('state the speeds the code runs: 0.55 up to a normal orbit instead of 2, in the section the keyboard page links to', () => {
    const cosmology = read('docs/COSMOLOGY.md')
    const section = cosmology.split('### Calm mode\n')[1]?.split('\n### ')[0] ?? ''
    expect(section).not.toBe('')
    expect(section).toContain('`calmSpeed(u) = 0.55 + 0.45·u`')
    expect(section).toContain('`CALM_MAX_SPEED`')
    expect(section).toContain('`slack`')
    expect(calmSpeed(0)).toBeCloseTo(0.55, 10)
    expect(calmSpeed(1)).toBeCloseTo(CALM_MAX_SPEED, 10)
    expect(CALM_MAX_SPEED).toBe(1)
    // "never 2×": the urgent end it replaces.
    expect(urgencySpeed(1)).toBeCloseTo(2, 10)

    const keyboard = read('docs/KEYBOARD.md')
    expect(keyboard).toContain('| `⇧ O`')
    expect(keyboard).toContain('(COSMOLOGY.md#calm-mode)')
    expect(read('README.md')).toContain('`⇧ O` is calm mode')
  })
})
