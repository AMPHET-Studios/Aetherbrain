import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, folderKey, type VaultFile } from '@aether/core'
import { lf } from './helpers/lf'

/**
 * Suns open into planets, then moons, in the app: a click on a sun opens it (and plays a note), the bar at the bottom picks a level,
 * `s` steps through the levels, Shift+S opens or closes every sun, selecting a body a closed sun is holding back opens the suns it
 * hangs in, and the levels are remembered per vault. The 3D side (which bodies each level shows) is in packages/graph/test.
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

/** What the sound module was asked to play: the real one makes no sound in node, so the store is given a recorder. */
interface Played {
  body: string[]
  sun: [number, number][]
}

async function freshStore(storage: MemoryStorage = new MemoryStorage()) {
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  const played: Played = { body: [], sun: [] }
  vi.doMock('../src/audio/sounds', () => ({
    playBody: (n: { id: string }) => void played.body.push(n.id),
    playSun: (level: number, previous: number) => void played.sun.push([level, previous]),
    soundSupported: () => true,
    setSoundVolume: () => {},
  }))
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
  /** The sun bar as server markup, from the store's live state (server rendering reads the initial state object, so the live one is copied onto it). */
  const sunBar = async (): Promise<string> => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { SunDial } = await import('../src/components/SunDial')
    Object.assign(store.useAether.getInitialState(), store.useAether.getState())
    return renderToStaticMarkup(createElement(SunDial))
  }
  return { s: () => store.useAether.getState(), storage, played, commands: COMMANDS, press, sunBar }
}

afterEach(() => {
  vi.doUnmock('../src/audio/sounds')
  vi.unstubAllGlobals()
})

const LONG = `${'word '.repeat(3100)}\n`
const FILES: VaultFile[] = [
  { path: 'Home.md', content: '# Home\n' },
  { path: 'Projects/Alpha/Plan.md', content: '# Plan\n' },
  { path: 'Projects/Alpha/Big.md', content: `# Big\n\n${LONG}` },
  { path: 'Projects/Alpha/Sub/Deep.md', content: '# Deep\n' },
  { path: 'Work/Todo.md', content: '# Todo\n' },
]
const vault = (location = 'memory://suns') => new MemoryVaultAdapter(FILES, { location })

const ROOT = folderKey('')
const PROJECTS = folderKey('Projects')
const ALPHA = folderKey('Projects/Alpha')
const SUB = folderKey('Projects/Alpha/Sub')
const WORK = folderKey('Work')

describe('what each sun holds', () => {
  it('counts planets, folders and moons for the bar, and has nothing for a sun it does not know', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    expect(s().sunCountsOf(ALPHA)).toEqual({ planets: 1, systems: 1, moons: 1 })
    expect(s().sunCountsOf(WORK)).toEqual({ planets: 0, systems: 0, moons: 1 })
    expect(s().sunCountsOf('folder:Nowhere')).toEqual({ planets: 0, systems: 0, moons: 0 })
  })
})

describe('how open each sun is', () => {
  it('starts closed, in the store and in the 3D view', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    expect(s().sunDefault).toBe(0)
    expect(s().sunOwn).toEqual({})
    expect(s().sunLevelOf(ALPHA)).toBe(0)
    expect(s().controller.sunLevel(ALPHA)).toBe(0)
    expect(s().settings.suns).toBe(true)
  })

  it('opens a sun to the level chosen, tells the 3D view, and saves it for this vault', async () => {
    const { s, storage } = await freshStore()
    await s().openVault(vault('memory://one'))
    s().chooseSun(ALPHA, 2)
    expect(s().sunLevelOf(ALPHA)).toBe(2)
    expect(s().controller.sunLevel(ALPHA)).toBe(2)
    expect(s().sunLevelOf(WORK)).toBe(0)
    expect(JSON.parse(storage.getItem('aether:suns:memory://one')!)).toEqual({ def: 0, own: { [ALPHA]: 2 } })
    // Back to closed: nothing of its own to keep.
    s().chooseSun(ALPHA, 0)
    expect(JSON.parse(storage.getItem('aether:suns:memory://one')!)).toEqual({ def: 0, own: {} })
  })

  it('steps through the levels a sun has something for: closed, planets, planets and moons, closed', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      s().cycleSun(ALPHA)
      seen.push(s().sunLevelOf(ALPHA))
    }
    expect(seen).toEqual([1, 2, 0, 1])
  })

  it('skips a level that has nothing: a sun with only moons goes closed and moons, one with no moons closed and planets', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    const stepsOf = (id: string): number[] => {
      const out: number[] = []
      for (let i = 0; i < 3; i++) {
        s().cycleSun(id)
        out.push(s().sunLevelOf(id))
      }
      return out
    }
    expect(stepsOf(WORK)).toEqual([2, 0, 2])
    expect(stepsOf(PROJECTS)).toEqual([1, 0, 1])
  })

  it('steps backward when asked to', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().cycleSun(ALPHA, -1)
    expect(s().sunLevelOf(ALPHA)).toBe(2)
    s().cycleSun(ALPHA, -1)
    expect(s().sunLevelOf(ALPHA)).toBe(1)
  })

  it('says so, and changes nothing, for a sun with nothing in it', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    await s().createFolder('Empty')
    s().cycleSun(folderKey('Empty'))
    expect(s().toasts.at(-1)?.text).toBe('Empty has nothing to open')
    expect(s().sunLevelOf(folderKey('Empty'))).toBe(0)
  })

  it('ignores a body that is not a sun', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().cycleSun('Home')
    expect(s().sunOwn).toEqual({})
  })

  it('plays the run of the change (its new level and its old one) while the sound is on, and nothing while it is off', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().chooseSun(ALPHA, 1)
    s().cycleSun(ALPHA)
    s().chooseSun(ALPHA, 0)
    expect(played.sun).toEqual([[1, 0], [2, 1], [0, 2]])
    s().setSettings({ sound: false })
    s().chooseSun(ALPHA, 2)
    s().cycleSun(ALPHA)
    expect(played.sun).toHaveLength(3)
  })

  it('remembers the levels for the next time the same vault is opened, and only for that vault', async () => {
    const storage = new MemoryStorage()
    const first = await freshStore(storage)
    await first.s().openVault(vault('memory://home'))
    first.s().chooseSun(ALPHA, 2)
    first.s().chooseSun(WORK, 2)
    first.s().chooseSun(WORK, 0)

    const again = await freshStore(storage)
    await again.s().openVault(vault('memory://home'))
    expect(again.s().sunLevelOf(ALPHA)).toBe(2)
    expect(again.s().controller.sunLevel(ALPHA)).toBe(2)
    expect(again.s().sunLevelOf(WORK)).toBe(0)

    const other = await freshStore(storage)
    await other.s().openVault(vault('memory://elsewhere'))
    expect(other.s().sunLevelOf(ALPHA)).toBe(0)
  })

  it('opens everything closed when what was saved is damaged, and keeps the good parts of a half-good save', async () => {
    const storage = new MemoryStorage()
    storage.setItem('aether:suns:memory://bad', '{not json')
    const bad = await freshStore(storage)
    await bad.s().openVault(vault('memory://bad'))
    expect(bad.s().sunOwn).toEqual({})
    expect(bad.s().sunDefault).toBe(0)

    storage.setItem('aether:suns:memory://odd', JSON.stringify({ def: 9, own: { [ALPHA]: 2, [WORK]: 'wide open', [SUB]: -4 } }))
    const odd = await freshStore(storage)
    await odd.s().openVault(vault('memory://odd'))
    expect(odd.s().sunDefault).toBe(0)
    expect(odd.s().sunLevelOf(ALPHA)).toBe(2)
    expect(odd.s().sunLevelOf(WORK)).toBe(0)
    expect(odd.s().sunLevelOf(SUB)).toBe(0)
  })
})

describe('every sun at once', () => {
  it('opens every sun to planets and moons, and the next press closes them all', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().toggleAllSuns()
    expect(s().sunDefault).toBe(2)
    expect(s().sunLevelOf(WORK)).toBe(2)
    expect(s().controller.sunLevel(WORK)).toBe(2)
    expect(s().toasts.at(-1)?.text).toBe('Every sun open: planets and moons')
    s().toggleAllSuns()
    expect(s().sunDefault).toBe(0)
    expect(s().sunLevelOf(WORK)).toBe(0)
    expect(s().toasts.at(-1)?.text).toBe('Every sun closed')
  })

  it('counts a single sun opened by hand as open: the press closes everything, whichever sun it was', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().chooseSun(ALPHA, 1)
    s().toggleAllSuns()
    expect(s().sunLevelOf(ALPHA)).toBe(0)
    expect(s().sunOwn).toEqual({})
  })

  it('sets every sun to one level, forgets the ones set by hand, and saves it', async () => {
    const { s, storage } = await freshStore()
    await s().openVault(vault('memory://all'))
    s().chooseSun(ALPHA, 2)
    s().setAllSuns(1)
    expect(s().sunLevelOf(ALPHA)).toBe(1)
    expect(s().sunOwn).toEqual({})
    expect(s().toasts.at(-1)?.text).toBe('Every sun open: planets')
    expect(JSON.parse(storage.getItem('aether:suns:memory://all')!)).toEqual({ def: 1, own: {} })
  })
})

describe('suns on and off', () => {
  it('switches the whole idea off (every planet and moon shows, always) and back on, saying which', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().toggleSuns()
    expect(s().settings.suns).toBe(false)
    expect(s().toasts.at(-1)?.text).toBe('Every planet and moon shows, always')
    s().toggleSuns()
    expect(s().settings.suns).toBe(true)
    expect(s().toasts.at(-1)?.text).toBe('Suns open and close: click one to see its planets, then its moons')
  })

  it('leaves the levels as they were while it is off, so switching it on again finds them', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().chooseSun(ALPHA, 2)
    s().toggleSuns()
    s().toggleSuns()
    expect(s().sunLevelOf(ALPHA)).toBe(2)
  })
})

describe('a click on a body', () => {
  it('plays the body’s note, opens a closed sun at the first level that has something, and the run of it opening', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().pickBody(ALPHA)
    expect(played.body).toEqual([ALPHA])
    expect(s().sunLevelOf(ALPHA)).toBe(1)
    expect(s().selectedId).toBe(ALPHA)
    expect(played.sun).toEqual([[1, 0]])
  })

  it('opens a sun that has only moons straight to its moons, and one with no planets but folders to its folders', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().pickBody(WORK)
    expect(s().sunLevelOf(WORK)).toBe(2)
    s().pickBody(PROJECTS)
    expect(s().sunLevelOf(PROJECTS)).toBe(1)
  })

  it('only plays a note for a body that is not a sun, and for a sun that is already open', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().pickBody('Home')
    expect(played.body).toEqual(['Home'])
    expect(played.sun).toEqual([])
    expect(s().sunOwn).toEqual({})
    s().chooseSun(ALPHA, 2)
    played.sun.length = 0
    s().pickBody(ALPHA)
    expect(played.body).toEqual(['Home', ALPHA])
    expect(played.sun).toEqual([])
    expect(s().sunLevelOf(ALPHA)).toBe(2)
  })

  it('still opens the sun with the sound off, and plays nothing', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().setSettings({ sound: false })
    s().pickBody(ALPHA)
    expect(s().sunLevelOf(ALPHA)).toBe(1)
    expect(played.body).toEqual([])
    expect(played.sun).toEqual([])
  })

  it('does not open anything when the suns are off, but still plays the note', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().setSettings({ suns: false })
    s().pickBody(ALPHA)
    expect(s().sunLevelOf(ALPHA)).toBe(0)
    expect(played.body).toEqual([ALPHA])
    expect(played.sun).toEqual([])
  })

  it('has no folders to click outside the system layout: a body there only plays its note', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().setSettings({ layoutMode: 'constellation' })
    // The folder is not in this layout's graph, so there is nothing to click.
    s().pickBody(ALPHA)
    expect(played.body).toEqual([])
    s().pickBody('Projects/Alpha/Plan')
    expect(played.body).toEqual(['Projects/Alpha/Plan'])
    expect(s().sunOwn).toEqual({})
  })

  it('does nothing for a body that is not in the graph', async () => {
    const { s, played } = await freshStore()
    await s().openVault(vault())
    s().pickBody('Nowhere')
    expect(played.body).toEqual([])
  })

  it('does not open an empty sun', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    await s().createFolder('Empty')
    s().pickBody(folderKey('Empty'))
    expect(s().sunLevelOf(folderKey('Empty'))).toBe(0)
  })
})

describe('selecting a body a closed sun is holding back', () => {
  it('opens the suns it hangs in, as far as it needs: a moon its sun to the moons, and that sun’s sun to the planets', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().select('Projects/Alpha/Plan')
    expect(s().sunLevelOf(ALPHA)).toBe(2)
    expect(s().sunLevelOf(PROJECTS)).toBe(1)
    expect(s().controller.sunLevel(ALPHA)).toBe(2)
  })

  it('opens just the planets for a planet', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().select('Projects/Alpha/Big')
    expect(s().sunLevelOf(ALPHA)).toBe(1)
  })

  it('opens every sun on the way up for a body deep inside', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().select('Projects/Alpha/Sub/Deep')
    expect(s().sunLevelOf(SUB)).toBe(2)
    expect(s().sunLevelOf(ALPHA)).toBe(1)
    expect(s().sunLevelOf(PROJECTS)).toBe(1)
  })

  it('opens the galaxy for a note that lives in the vault’s root', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().select('Home')
    expect(s().sunLevelOf(ROOT)).toBe(2)
  })

  it('never closes a sun that is more open than it needs to be', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().chooseSun(ALPHA, 2)
    s().select('Projects/Alpha/Big')
    expect(s().sunLevelOf(ALPHA)).toBe(2)
  })

  it('leaves the suns alone for a body that is always shown, and for a deselect', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().select(WORK)
    s().select(PROJECTS)
    s().select(null)
    expect(s().sunOwn).toEqual({})
  })

  it('leaves the suns alone when they are off or the layout is not the system layout', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().setSettings({ suns: false })
    s().select('Projects/Alpha/Plan')
    expect(s().sunOwn).toEqual({})
    s().setSettings({ suns: true, layoutMode: 'constellation' })
    s().select('Projects/Alpha/Plan')
    expect(s().sunOwn).toEqual({})
  })

  it('does it however the selection is made: opening a note (a search), going back and going forward', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    s().openNote('Projects/Alpha/Plan')
    expect(s().sunLevelOf(ALPHA)).toBe(2)
    s().openNote('Work/Todo')
    expect(s().sunLevelOf(WORK)).toBe(2)
    s().setAllSuns(0)
    s().goBack()
    expect(s().selectedId).toBe('Projects/Alpha/Plan')
    expect(s().sunLevelOf(ALPHA)).toBe(2)
    s().setAllSuns(0)
    s().goForward()
    expect(s().selectedId).toBe('Work/Todo')
    expect(s().sunLevelOf(WORK)).toBe(2)
  })

  it('saves what it opened, so a search is still open after a restart', async () => {
    const storage = new MemoryStorage()
    const first = await freshStore(storage)
    await first.s().openVault(vault('memory://search'))
    first.s().openNote('Projects/Alpha/Plan')
    const again = await freshStore(storage)
    await again.s().openVault(vault('memory://search'))
    expect(again.s().sunLevelOf(ALPHA)).toBe(2)
  })
})

describe('the sun bar', () => {
  it('names the sun and what it holds, with a button for each level and the current one pressed', async () => {
    const { s, sunBar } = await freshStore()
    await s().openVault(vault())
    s().chooseSun(ALPHA, 1)
    s().select(ALPHA)
    const out = await sunBar()
    expect(out).toContain('aria-label="How open Alpha is"')
    expect(out).toContain('☀ Alpha')
    expect(out).toContain('1 planet · 1 folder · 1 moon')
    for (const name of ['Closed', 'Planets', 'Planets + moons']) expect(out).toContain(`>${name}</button>`)
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(out).toMatch(/aria-pressed="true"[^>]*>Planets</)
    expect(out).not.toContain('disabled')
  })

  it('turns off a level the sun has nothing for', async () => {
    const { s, sunBar } = await freshStore()
    await s().openVault(vault())
    s().select(WORK)
    const out = await sunBar()
    expect(out).toContain('1 moon')
    expect(out).toMatch(/disabled=""[^>]*>Planets</)
    expect(out).not.toMatch(/disabled=""[^>]*>Planets \+ moons</)
  })

  it('says there is nothing to open for an empty sun, with no buttons', async () => {
    const { s, sunBar } = await freshStore()
    await s().openVault(vault())
    await s().createFolder('Empty')
    s().select(folderKey('Empty'))
    const out = await sunBar()
    expect(out).toContain('nothing to open')
    expect(out).not.toContain('<button')
  })

  it('is not there for a body that is not a sun, with the suns off, or outside the system layout', async () => {
    const { s, sunBar } = await freshStore()
    await s().openVault(vault())
    s().select('Home')
    expect(await sunBar()).toBe('')
    s().select(ALPHA)
    expect(await sunBar()).not.toBe('')
    s().setSettings({ suns: false })
    expect(await sunBar()).toBe('')
    s().setSettings({ suns: true, layoutMode: 'constellation' })
    expect(await sunBar()).toBe('')
  })

  it('is not there when nothing is selected', async () => {
    const { s, sunBar } = await freshStore()
    await s().openVault(vault())
    expect(await sunBar()).toBe('')
  })
})

describe('the palette and the keys', () => {
  it('has a command for each: the next level of a sun, every sun, the whole idea, and the sound', async () => {
    const { commands } = await freshStore()
    const by = (id: string) => commands.find((c) => c.id === id)!
    expect(by('sun-next').keys).toBe('s')
    expect(by('suns-all').keys).toBe('Shift+S')
    expect(by('suns-setting').title).toContain('Suns')
    expect(by('sound').keys).toBe('Shift+M')
    for (const id of ['sun-next', 'suns-all', 'suns-setting', 'sound']) expect(by(id).group, id).toBe('view')
  })

  it('offers the next level only where there is a sun to step', async () => {
    const { s, commands } = await freshStore()
    await s().openVault(vault())
    const next = commands.find((c) => c.id === 'sun-next')!
    expect(next.when!(s())).toBe(false)
    s().select('Home')
    // A body in the galaxy: its sun is the galaxy.
    expect(next.when!(s())).toBe(true)
    s().select(ALPHA)
    expect(next.when!(s())).toBe(true)
    s().setSettings({ suns: false })
    expect(next.when!(s())).toBe(false)
  })

  it('s steps the selected sun, and the sun of a selected body that is not one', async () => {
    const { s, press } = await freshStore()
    await s().openVault(vault())
    s().select(ALPHA)
    press('s')
    expect(s().sunLevelOf(ALPHA)).toBe(1)
    press('s')
    expect(s().sunLevelOf(ALPHA)).toBe(2)
    s().select('Projects/Alpha/Plan')
    press('s')
    expect(s().sunLevelOf(ALPHA)).toBe(0)
  })

  it('s with nothing selected does nothing, and Shift+S opens or closes every sun', async () => {
    const { s, press } = await freshStore()
    await s().openVault(vault())
    press('s')
    expect(s().sunOwn).toEqual({})
    press('S', true)
    expect(s().sunDefault).toBe(2)
    press('s', true)
    expect(s().sunDefault).toBe(0)
  })

  it('Shift+M switches the sound off and on', async () => {
    const { s, press } = await freshStore()
    await s().openVault(vault())
    expect(s().settings.sound).toBe(true)
    press('M', true)
    expect(s().settings.sound).toBe(false)
    expect(s().toasts.at(-1)?.text).toBe('Sound off')
    press('m', true)
    expect(s().settings.sound).toBe(true)
    expect(s().toasts.at(-1)?.text).toContain('Sound on')
    // The plain m is still the colour mode.
    const mode = s().settings.colorMode
    press('m')
    expect(s().settings.colorMode).not.toBe(mode)
  })
})

describe('the guides', () => {
  const doc = (p: string) => lf(readFileSync(new URL(`../../../docs/${p}`, import.meta.url), 'utf8'))

  it('say how a sun opens: the click, the bar, s, Shift+S and the sound', () => {
    const keys = doc('KEYBOARD.md')
    expect(keys).toContain('`s`')
    expect(keys).toContain('`⇧ S`')
    expect(keys).toContain('`⇧ M`')
    const cosmology = doc('COSMOLOGY.md')
    expect(cosmology).toContain('## Suns open')
    expect(cosmology).toContain('Planets + moons')
  })
})
