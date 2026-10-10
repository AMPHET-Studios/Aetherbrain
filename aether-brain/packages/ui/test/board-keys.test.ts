import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'
import { BOARD_COMMANDS, boardHelpRows } from '../src/board/commands'
import { assetFiles, freshApp, vaultFiles } from './board-integration-harness'

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------- the key handler --- */

interface Press {
  key: string
  code?: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  target?: { tagName: string; role?: string; editable?: boolean }
}

/** A keydown as the global handler sees it; `target` fakes the focused element. */
function keyEvent(p: Press) {
  const target = p.target ?? { tagName: 'BODY' }
  const blur = vi.fn()
  return {
    key: p.key,
    code: p.code ?? '',
    metaKey: !!p.meta,
    ctrlKey: !!p.ctrl,
    altKey: !!p.alt,
    shiftKey: !!p.shift,
    repeat: false,
    defaultPrevented: false,
    blur,
    target: {
      tagName: target.tagName,
      isContentEditable: !!target.editable,
      getAttribute: (n: string) => (n === 'role' ? (target.role ?? null) : null),
      hasAttribute: () => false,
      blur,
    },
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {},
  }
}

/** A fresh app with every store action replaced by a recorder, and a camera that records too: what the global keys would have done. */
async function spied() {
  const app = await freshApp()
  await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
  const { handleKey, registerKey } = await import('../src/hooks/useKeyboard')
  const calls: string[] = []
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(app.s())) if (typeof v === 'function') patch[k] = () => void calls.push(k)
  app.useAether.setState(patch)
  const camera = { orbit: () => calls.push('camera.orbit'), truck: () => calls.push('camera.truck'), dolly: () => calls.push('camera.dolly') }
  ;(app.s().controller as unknown as { camera: unknown }).camera = camera
  const resetCamera = vi.spyOn(app.s().controller, 'resetCamera').mockImplementation(() => void calls.push('controller.resetCamera'))
  const flyTo = vi.spyOn(app.s().controller, 'flyTo').mockImplementation(() => void calls.push('controller.flyTo'))
  void resetCamera
  void flyTo
  const press = (p: Press) => {
    calls.length = 0
    const e = keyEvent(p)
    handleKey(e as unknown as KeyboardEvent)
    return { calls: [...calls], prevented: e.defaultPrevented, blurred: e.blur.mock.calls.length > 0 }
  }
  /** Look at the board view as the user does: a board open, or the list. */
  const showBoards = (open: boolean) => app.useAether.setState({ view: 'boards', boardPath: open ? 'Boards/Armour.md' : null, selectedId: 'Inbox/Idea' })
  return { ...app, calls, press, registerKey, showBoards }
}

/** Every key a test may press: letters of both cases (shifted ones with shift), digits, punctuation, named keys. */
function everyKey(): Press[] {
  const out: Press[] = []
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    out.push({ key: c, code: `Key${c.toUpperCase()}` })
    out.push({ key: c.toUpperCase(), code: `Key${c.toUpperCase()}`, shift: true })
  }
  for (const d of '0123456789') out.push({ key: d, code: `Digit${d}` })
  for (const c of '`-=[]\\;\',./~_+{}|:"<>?!@#$%^&*()') out.push({ key: c, shift: '~_+{}|:"<>?!@#$%^&*()'.includes(c) })
  for (const key of ['Enter', 'Tab', 'Home', 'End', 'Delete', 'Backspace', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'F1', 'PageUp']) out.push({ key })
  out.push({ key: 'Tab', shift: true }, { key: 'ArrowLeft', shift: true }, { key: 'ArrowUp', shift: true })
  return out
}

/** What the Boards view leaves to the app, and what each does. */
const LEFT_TO_THE_APP: Record<string, string[]> = {
  '?': ['setHelp'],
  '/': ['setPalette'],
  '2': ['openNote'],
  '3': ['setView'],
  '4': ['setPalette'],
  '5': ['setView'],
  '6': ['setView'],
  '7': ['showToday'],
  '8': ['openBoards'],
}
const name = (p: Press) => `${p.shift ? 'Shift+' : ''}${p.key === ' ' ? 'Space' : p.key}`

describe('the global keys while the Boards view is up', () => {
  for (const open of [true, false]) {
    it(`never fires a key of the 3D view over ${open ? 'a board' : 'the list of boards'}, except the few it leaves to the app`, async () => {
      const k = await spied()
      k.showBoards(open)
      const fired: string[] = []
      for (const p of everyKey()) {
        const { calls } = k.press(p)
        const left = LEFT_TO_THE_APP[p.key]
        // Shift+B is the second key of the boards, like 8.
        const boards = p.shift && p.key.toLowerCase() === 'b'
        if (boards) expect(calls, name(p)).toEqual(['openBoards'])
        else if (left) expect(calls, name(p)).toEqual(left)
        else expect(calls, name(p)).toEqual([])
        if (calls.length) fired.push(name(p))
      }
      expect(fired.sort()).toEqual(['/', '2', '3', '4', '5', '6', '7', '8', 'Shift+?', 'Shift+B'].sort())
    })
  }

  it('fires them all outside it (so the test above bites): the same presses do plenty in the graph', async () => {
    const k = await spied()
    k.useAether.setState({ view: 'graph', boardPath: null, selectedId: 'Inbox/Idea' })
    const fired = everyKey().filter((p) => k.press(p).calls.length > 0)
    expect(fired.length).toBeGreaterThan(40)
    for (const key of ['b', 'l', 't', 'm', 'z', 'e', 'c', 'p', 'r', 'o', 'u', 'd', 'y', 'f', 'Home', 'Tab']) expect(fired.map((p) => p.key), key).toContain(key)
  })

  it('keeps every key of the board’s own table away from the 3D view, with and without shift, ctrl or meta', async () => {
    const k = await spied()
    k.showBoards(true)
    let n = 0
    for (const c of BOARD_COMMANDS) {
      for (const alt of (c.keys ?? '').split(' / ').filter(Boolean)) {
        const tokens = alt.split(' ')
        const last = tokens[tokens.length - 1]!
        const key = last === 'Esc' ? 'Escape' : last === '⌫' ? 'Backspace' : last
        if (key === 'Escape' || key === '1') continue
        for (const mod of ['ctrl', 'meta'] as const) {
          const res = k.press({ key: /^[a-z]$/.test(key) && tokens.includes('⇧') ? key.toUpperCase() : key, shift: tokens.includes('⇧'), alt: tokens.includes('⌥'), [mod]: tokens.includes('⌘') })
          expect(res.calls, `${alt} (${mod})`).toEqual([])
          n++
        }
      }
    }
    expect(n).toBeGreaterThan(80)
  })

  it('leaves 1 to the board’s zoom to 100%: it is not the Graph view key there', async () => {
    const k = await spied()
    k.showBoards(true)
    expect(k.press({ key: '1' }).calls).toEqual([])
    k.useAether.setState({ view: 'graph' })
    expect(k.press({ key: '1' }).calls).toEqual(['setView'])
  })

  it('does not take Tab: the view’s controls keep it', async () => {
    const k = await spied()
    k.showBoards(false)
    const res = k.press({ key: 'Tab' })
    expect(res).toMatchObject({ calls: [], prevented: false })
    k.useAether.setState({ view: 'graph' })
    expect(k.press({ key: 'Tab' })).toMatchObject({ calls: ['cycleNeighbor'], prevented: true })
  })

  it('never fires while a text field has the focus, or the palette or the cheatsheet is open', async () => {
    const k = await spied()
    k.showBoards(true)
    for (const key of ['8', '/', '?', '2', 'b']) {
      expect(k.press({ key, target: { tagName: 'INPUT' } }).calls, key).toEqual([])
      expect(k.press({ key, target: { tagName: 'TEXTAREA' } }).calls, key).toEqual([])
    }
    k.useAether.setState({ paletteOpen: true })
    expect(k.press({ key: '8' }).calls).toEqual([])
    k.useAether.setState({ paletteOpen: false, helpOpen: true })
    expect(k.press({ key: '8' }).calls).toEqual([])
  })
})

describe('getting to the boards', () => {
  it('8 and Shift+B open the boards from anywhere', async () => {
    const k = await spied()
    expect(k.press({ key: '8' })).toMatchObject({ calls: ['openBoards'], prevented: false })
    expect(k.press({ key: 'B', code: 'KeyB', shift: true }).calls).toEqual(['openBoards'])
    // Caps Lock turns Shift+B into a lower case b: Shift decides.
    expect(k.press({ key: 'b', code: 'KeyB', shift: true }).calls).toEqual(['openBoards'])
    // …and a plain b is still the bloom.
    expect(k.press({ key: 'b', code: 'KeyB' }).calls).toEqual(['setSettings'])
  })

  it('8 and Shift+B are “up” inside the view', async () => {
    const k = await spied()
    k.showBoards(true)
    expect(k.press({ key: '8' })).toMatchObject({ calls: ['openBoards'], prevented: true })
    expect(k.press({ key: 'B', shift: true })).toMatchObject({ calls: ['openBoards'], prevented: true })
  })

  it('do nothing with ctrl, meta or alt, in a text field or behind the palette', async () => {
    const k = await spied()
    for (const mod of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      expect(k.press({ key: '8', ...mod }).calls).toEqual([])
      expect(k.press({ key: 'B', shift: true, ...mod }).calls).toEqual([])
    }
    expect(k.press({ key: '8', target: { tagName: 'INPUT' } }).calls).toEqual([])
    k.useAether.setState({ paletteOpen: true })
    expect(k.press({ key: '8' }).calls).toEqual([])
  })
})

describe('Esc', () => {
  it('closes the Boards view, a board or the list, like the other overlay views', async () => {
    for (const open of [true, false]) {
      const k = await spied()
      k.showBoards(open)
      expect(k.press({ key: 'Escape' }).calls).toEqual(['setView'])
    }
  })

  it('closes the cheatsheet and the palette first, and the view only after', async () => {
    const k = await spied()
    k.showBoards(true)
    k.useAether.setState({ helpOpen: true })
    expect(k.press({ key: 'Escape' }).calls).toEqual(['setHelp'])
    k.useAether.setState({ helpOpen: false, paletteOpen: true })
    expect(k.press({ key: 'Escape' }).calls).toEqual(['setPalette'])
  })

  it('in a text field of the view, only lets go of the field', async () => {
    const k = await spied()
    k.showBoards(true)
    const res = k.press({ key: 'Escape', target: { tagName: 'TEXTAREA' } })
    expect(res.calls).toEqual([])
    expect(res.blurred).toBe(true)
  })

  it('leaves the board remembered: the view closes, 8 brings it back', async () => {
    const app = await freshApp()
    await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    const { handleKey } = await import('../src/hooks/useKeyboard')
    app.s().openBoard('Boards/Armour.md')
    handleKey(keyEvent({ key: 'Escape' }) as unknown as KeyboardEvent)
    expect(app.s()).toMatchObject({ view: 'graph', boardPath: 'Boards/Armour.md' })
    handleKey(keyEvent({ key: '8' }) as unknown as KeyboardEvent)
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Armour.md' })
  })
})

describe('keys the desktop app adds', () => {
  it('work over a board unless the board has a use for the same key', async () => {
    const k = await spied()
    const ran: string[] = []
    for (const key of ['w', 'q', 'v', 'a', 'g', 'P', 'L']) k.registerKey(key, () => void ran.push(key))
    k.showBoards(true)
    for (const p of [{ key: 'w' }, { key: 'q' }, { key: 'v' }, { key: 'a' }, { key: 'g' }, { key: 'P', shift: true }, { key: 'L', shift: true }]) k.press(p)
    // w and q are not the board's; v (select), a (arrange) and g (grey) are; Shift+P and Shift+L are not.
    expect(ran).toEqual(['w', 'q', 'P', 'L'])
    ran.length = 0
    k.useAether.setState({ view: 'graph' })
    for (const p of [{ key: 'w' }, { key: 'q' }, { key: 'v' }, { key: 'a' }, { key: 'g' }, { key: 'P', shift: true }, { key: 'L', shift: true }]) k.press(p)
    expect(ran).toEqual(['w', 'q', 'v', 'a', 'g', 'P', 'L'])
  })

  it('work over the list of boards the same way', async () => {
    const k = await spied()
    const ran: string[] = []
    k.registerKey('w', () => void ran.push('w'))
    k.registerKey('b', () => void ran.push('b'))
    k.showBoards(false)
    k.press({ key: 'w' })
    k.press({ key: 'b' })
    expect(ran).toEqual(['w'])
  })
})

/* -------------------------------------------------------------------------- the docs --- */

const docsUrl = (name: string) => new URL(`../../../docs/${name}`, import.meta.url)
const doc = readFileSync(docsUrl('KEYBOARD.md'), 'utf8')
const guide = readFileSync(docsUrl('REFERENCE-BOARD.md'), 'utf8')

/** The section of `text` under the `## <heading>` line, up to the next heading of its level. */
function sectionOf(text: string, heading: string): string {
  const from = text.indexOf(`\n## ${heading}\n`)
  expect(from, `a "${heading}" section`).toBeGreaterThan(-1)
  const rest = text.slice(from + 1)
  const next = rest.indexOf('\n## ', 3)
  return next < 0 ? rest : rest.slice(0, next)
}

/** The "Reference boards" section of docs/KEYBOARD.md. */
const boardSection = (): string => sectionOf(doc, 'Reference boards')

/** The key texts a section's tables list: every `code span` in the first cell of a table row. */
function keysOf(section: string): string[] {
  const keys: string[] = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const first = line.split('|')[1] ?? ''
    for (const m of first.matchAll(/`([^`]+)`/g)) keys.push(m[1]!)
  }
  return keys
}
const documentedKeys = (): string[] => keysOf(boardSection())

/** Every key the table (and the cheatsheet's extra rows) defines, one text per alternative. */
function tableKeys(): string[] {
  const out: string[] = []
  for (const row of boardHelpRows()) for (const alt of row.keys.split(' / ')) out.push(alt)
  return out
}

/** Keys the docs list that are not the board's own: the view's way in. */
const VIEW_KEYS = ['8', '⇧ B', 'n']

describe('docs/KEYBOARD.md and the table of keys', () => {
  it('documents every key of every command, and every gesture of the cheatsheet', () => {
    const documented = new Set(documentedKeys())
    const missing = tableKeys().filter((k) => !documented.has(k))
    expect(missing).toEqual([])
    expect(tableKeys().length).toBeGreaterThan(55)
  })

  it('documents no board key that the table does not have', () => {
    const table = new Set([...tableKeys(), ...VIEW_KEYS])
    const extra = documentedKeys().filter((k) => !table.has(k))
    expect(extra).toEqual([])
  })

  it('documents the keys of the view too: 8, Shift+B and n', () => {
    const documented = new Set(documentedKeys())
    for (const k of VIEW_KEYS) expect(documented.has(k), k).toBe(true)
  })

  it('writes each key once in the section', () => {
    const keys = documentedKeys()
    // Esc is the board's select-none and the ladder's: one row.
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  it('names, in its palette-only paragraph, every command that has no key (a new one makes this test fail until the docs say so)', () => {
    const paragraph = boardSection().split('\n').find((l) => l.startsWith('Palette only'))
    expect(paragraph).toBeDefined()
    const words: [RegExp, string][] = [
      [/^transform\.reset/, 'reset rotation / size / crop'],
      [/^arrange\./, 'arrange row / column / grid / pile / optimal'],
      [/^sort\./, 'sort by name / added / size / shuffle'],
      [/^align\./, 'align and distribute'],
      [/^distribute\./, 'align and distribute'],
      [/^normalize\.scale$/, "show at the pictures' own size"],
      [/^normalize\./, 'make the same width / height / size'],
      [/^picture\.reveal$/, 'show in the file manager'],
      [/^picture\.showInBrain$/, 'show in the brain'],
      [/^picture\.info$/, 'picture info'],
      [/^picture\.palette$/, 'extract a colour palette'],
    ]
    const keyless = BOARD_COMMANDS.filter((c) => !c.keys && !c.id.startsWith('window.'))
    expect(keyless.length).toBeGreaterThan(20)
    for (const c of keyless) {
      const hit = words.find(([re]) => re.test(c.id))
      expect(hit, `${c.id} has no key and no words in this test: say it in the docs, then here`).toBeDefined()
      expect(paragraph!.toLowerCase(), c.id).toContain(hit![1].split(' / ')[0]!.toLowerCase())
    }
    for (const t of ['pop out into its own window', 'dock back', 'always on top', 'window opacity']) expect(paragraph!.toLowerCase()).toContain(t)
    expect(paragraph).toContain('Boards: add the selected picture to the last board')
  })

  it('lists the desktop’s w (pop out) where the desktop keys are, and the picture inspector’s menu', () => {
    expect(doc).toMatch(/\| `w` +\| Reference board: pop the board/)
    expect(doc).toContain('*Add to board ▾*')
  })

  it('lists the boards in the Everywhere table, the Esc line and the palette list', () => {
    expect(doc).toMatch(/\| `8` · `⇧ B` \| Boards:/)
    expect(doc).toContain('Boards: open (`8` · `⇧ B`)')
    expect(doc).toContain('over a board, the board\'s own Esc ladder goes first')
  })
})

describe('docs/REFERENCE-BOARD.md', () => {
  it('lists the same keys as the table, in its Keys section', () => {
    const keys = keysOf(sectionOf(guide, 'Keys'))
    const table = new Set([...tableKeys(), ...VIEW_KEYS])
    expect(keys.filter((k) => !table.has(k)), 'keys the table does not have').toEqual([])
    const listed = new Set(keys)
    expect([...table].filter((k) => !listed.has(k)), 'keys the guide leaves out').toEqual([])
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  it('has every link and anchor it points at', () => {
    const slug = (h: string) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')
    const headings = new Set([...guide.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)))
    for (const m of guide.matchAll(/\]\(#([^)]+)\)/g)) expect(headings.has(m[1]!), `#${m[1]}`).toBe(true)
    for (const m of guide.matchAll(/\]\(([A-Za-z0-9_.-]+\.md)(#[^)]*)?\)/g)) expect(existsSync(docsUrl(m[1]!)), m[1]).toBe(true)
  })

  it('names the commands and limits the code has', async () => {
    const { BOARD_LIMITS } = await import('@aether/core')
    expect(guide).toContain(BOARD_LIMITS.items.toLocaleString('en-US'))
    expect(guide).toContain(String(BOARD_LIMITS.noteChars).replace(/(\d)(?=(\d{3})+$)/g, '$1,'))
    expect(guide).toContain(String(BOARD_LIMITS.strokePoints).replace(/(\d)(?=(\d{3})+$)/g, '$1,'))
    expect(guide).toContain(BOARD_LIMITS.noteTotal.toLocaleString('en-US'))
    for (const phrase of ['Board: Pop out to its own window', 'Board: Always on top', 'Pop out', 'Bring it back', 'Add to board']) expect(guide, phrase).toContain(phrase)
  })
})

describe('the cheatsheet', () => {
  it('has a Reference boards group with every row of the table, and the way in', async () => {
    const app = await freshApp()
    app.useAether.setState({ helpOpen: true })
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Help } = await import('../src/components/Help')
    Object.assign(app.useAether.getInitialState(), app.useAether.getState())
    const html = renderToStaticMarkup(createElement(Help))
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
    expect(html).toContain('Reference boards')
    expect(html).toContain('8 · ⇧B')
    for (const row of boardHelpRows()) {
      expect(html, row.keys).toContain(esc(row.keys))
      expect(html, row.label).toContain(esc(row.label))
    }
  })
})
