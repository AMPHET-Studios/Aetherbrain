import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, imageKey, type VaultFile } from '@aether/core'
import type { BoardHost } from '../src/board/api'
import type { BoardWindowControl, BoardWindowStatus } from '../src/board/active'
import { assetFiles, boardRaw, freshApp, vaultFiles } from './board-integration-harness'

afterEach(() => {
  vi.doUnmock('../src/board/BoardView')
  vi.unstubAllGlobals()
})

/** The Boards view as server markup over a fresh store; the board itself (another module's) is a marker that records the host it got. */
async function renderer(stored?: Record<string, string>) {
  const app = await freshApp(stored)
  const hosts: { host: BoardHost; className?: string }[] = []
  vi.doMock('../src/board/BoardView', async () => {
    const { createElement } = await import('react')
    return {
      BoardView: (props: { host: BoardHost; className?: string }) => {
        hosts.push(props)
        return createElement('div', { 'data-board-view': props.host.path, className: props.className })
      },
    }
  })
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const view = await import('../src/board/BoardsView')
  // The server renders from the store's initial state: bring it up to the present.
  const html = () => {
    Object.assign(app.useAether.getInitialState(), app.useAether.getState())
    return renderToStaticMarkup(createElement(view.BoardsView))
  }
  return { ...app, html, hosts, view }
}

const vault = (files: VaultFile[] = vaultFiles()) => new MemoryVaultAdapter(files, { assets: assetFiles() })

function fakeControl(status: Partial<BoardWindowStatus> = {}): BoardWindowControl {
  const full: BoardWindowStatus = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: true, ...status }
  return {
    available: true,
    status: () => full,
    subscribe: () => () => undefined,
    popOut: async () => true,
    dock: async () => undefined,
    setAlwaysOnTop: async () => undefined,
    setOpacity: async () => undefined,
    onReturned: () => () => undefined,
    setFlush: () => () => undefined,
  }
}

describe('while the view is closed', () => {
  it('draws nothing, and builds nothing', async () => {
    const r = await renderer()
    await r.open(vault())
    expect(r.html()).toBe('')
    r.s().openBoard('Boards/Armour.md')
    r.s().setView('graph')
    expect(r.html()).toBe('')
    expect(r.hosts).toHaveLength(0)
  })
})

describe('the list of boards', () => {
  it('shows a card per board, the newest first, with what is on it', async () => {
    const r = await renderer()
    await r.open(vault())
    r.s().setView('boards')
    const html = r.html()
    expect(html).toContain('aria-label="Boards"')
    expect(html).toContain('2 boards')
    expect(html.indexOf('Gate reference')).toBeGreaterThan(-1)
    expect(html.indexOf('Gate reference')).toBeLessThan(html.indexOf('Armour'))
    expect(html).toContain('2 pictures')
    expect(html).toContain('0 pictures')
    expect(html).toContain('aria-label="Open the board Gate reference"')
    expect(html).toContain('aria-label="Edit the note Gate reference"')
    // No window control on the web: no pop-out button on the cards.
    expect(html).not.toContain('in its own window')
    expect(r.hosts).toHaveLength(0)
  })

  it('has a New board button, a New board tile and a search box', async () => {
    const r = await renderer()
    await r.open(vault())
    r.s().setView('boards')
    const html = r.html()
    expect(html).toContain('＋ New board')
    expect(html).toContain('Make a new board (n)')
    expect(html).toContain('aria-label="Find a board"')
    expect(html.match(/New board/g)!.length).toBeGreaterThanOrEqual(2)
  })

  it('offers a pop-out button on each card on the desktop', async () => {
    const r = await renderer()
    await r.open(vault())
    r.active.setBoardWindowControl(fakeControl())
    r.s().setView('boards')
    expect(r.html()).toContain('aria-label="Open Gate reference in its own window"')
  })

  it('explains boards and offers a first one when there is none', async () => {
    const r = await renderer()
    await r.open(new MemoryVaultAdapter([{ path: 'Inbox/Idea.md', content: '# Idea\n' }]))
    r.s().setView('boards')
    const html = r.html()
    expect(html).toContain('Keep your references in one place')
    expect(html).toContain('ordinary note in your vault')
    expect(html).toContain('＋ New board')
    expect(html).not.toContain('Find a board')
    expect(html).not.toContain('0 pictures')
  })

  it('cannot make a board in a vault that is read-only', async () => {
    const r = await renderer()
    await r.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true }))
    r.s().setView('boards')
    const html = r.html()
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>＋ New board/)
    // The New board tile is not there either.
    expect(html).not.toContain('<span class="text-[28px] leading-none">＋</span>')
  })

  it('draws a page of cards at a time, and says how many are not drawn', async () => {
    const r = await renderer()
    const many = Array.from({ length: 60 }, (_, i): VaultFile => ({ path: `Boards/Board ${String(i).padStart(2, '0')}.md`, content: boardRaw(`Board ${String(i).padStart(2, '0')}`, [], `2026-09-${String((i % 28) + 1).padStart(2, '0')}`) }))
    await r.open(new MemoryVaultAdapter(many))
    r.s().setView('boards')
    const html = r.html()
    expect(html.match(/aria-label="Open the board /g)).toHaveLength(r.view.CARDS_FIRST)
    expect(html).toContain(`Show ${r.view.CARDS_MORE} more`)
    expect(html).toContain(`${60 - r.view.CARDS_FIRST} boards not shown`)
  })

  it('shortens a title that is a whole page long', async () => {
    const r = await renderer()
    const title = 'T'.repeat(5000)
    await r.open(new MemoryVaultAdapter([{ path: 'Boards/Long.md', content: boardRaw(title) }]))
    r.s().setView('boards')
    const html = r.html()
    // Every place the title is drawn: the card, its tooltip and its labels.
    expect(html.includes('T'.repeat(500))).toBe(false)
    expect(html.includes('T'.repeat(100))).toBe(true)
    expect(html.length).toBeLessThan(20_000)
    r.s().openBoard('Boards/Long.md')
    const open = r.html()
    expect(open.includes('T'.repeat(500))).toBe(false)
    expect(open.includes('T'.repeat(100))).toBe(true)
  })

  it('leaves the pictures of a card to the browser: the markup holds no picture', async () => {
    const r = await renderer()
    await r.open(vault())
    r.s().setView('boards')
    expect(r.html()).not.toContain('<img')
  })
})

describe('an open board', () => {
  it('shows the breadcrumb and gives the board its host, for this path', async () => {
    const r = await renderer()
    await r.open(vault())
    r.s().openBoard('Boards/Gate reference.md')
    const html = r.html()
    expect(html).toContain('aria-label="Board Gate reference"')
    expect(html).toContain('← Boards')
    expect(html).toContain('title="All boards (8)"')
    expect(html).toContain('Boards/Gate reference.md')
    expect(html).toContain('data-board-view="Boards/Gate reference.md"')
    expect(r.hosts).toHaveLength(1)
    expect(r.hosts[0]!.host.path).toBe('Boards/Gate reference.md')
    expect(r.hosts[0]!.host.title).toBe('Gate reference')
    expect(r.hosts[0]!.className).toContain('absolute')
  })

  it('draws nothing for a board whose note is gone', async () => {
    const r = await renderer()
    const v = await r.open(vault())
    r.s().openBoard('Boards/Armour.md')
    await v.remove('Boards/Armour.md')
    expect(r.html()).toBe('')
  })

  it('has no pop-out placeholder where the window does not exist', async () => {
    const r = await renderer()
    await r.open(vault())
    r.s().openBoard('Boards/Armour.md')
    expect(r.html()).not.toContain('open in its window')
  })
})

describe('a board that is open in its window', () => {
  it('shows a placeholder instead of the board, and the window’s state', async () => {
    const r = await renderer()
    await r.open(vault())
    r.active.setBoardWindowControl(fakeControl({ open: true, path: 'Boards/Armour.md', alwaysOnTop: true, opacity: 0.8 }))
    r.s().openBoard('Boards/Armour.md')
    const html = r.html()
    expect(html).toContain('This board is open in its window')
    expect(html).toContain('Bring it back')
    expect(html).toContain('Stays on top')
    expect(html).toContain('80%')
    expect(html).toContain('aria-label="More see-through"')
    expect(html).not.toContain('data-board-view')
    // No host was made, so nothing is read or saved from here while the window has the board.
    expect(r.hosts).toHaveLength(0)
  })

  it('says when the window is not on top, and leaves out the opacity where the platform has none', async () => {
    const r = await renderer()
    await r.open(vault())
    r.active.setBoardWindowControl(fakeControl({ open: true, path: 'Boards/Armour.md', alwaysOnTop: false, supportsOpacity: false }))
    r.s().openBoard('Boards/Armour.md')
    const html = r.html()
    expect(html).toContain('Not on top')
    expect(html).not.toContain('Window opacity')
    expect(html).not.toContain('%')
  })

  it('knows the board by its path whatever the letter case (Windows, macOS)', async () => {
    const r = await renderer()
    await r.open(vault())
    r.active.setBoardWindowControl(fakeControl({ open: true, path: 'boards/ARMOUR.md' }))
    r.s().openBoard('Boards/Armour.md')
    expect(r.html()).toContain('This board is open in its window')
  })

  it('shows the board when the window has another one, or has been closed', async () => {
    const r = await renderer()
    await r.open(vault())
    r.active.setBoardWindowControl(fakeControl({ open: true, path: 'Boards/Gate reference.md' }))
    r.s().openBoard('Boards/Armour.md')
    expect(r.html()).toContain('data-board-view="Boards/Armour.md"')
    r.active.setBoardWindowControl(fakeControl({ open: false, path: null }))
    expect(r.html()).toContain('data-board-view="Boards/Armour.md"')
    expect(r.html()).not.toContain('open in its window')
  })
})

describe('the picture inspector’s Add to board', () => {
  /** The inspector as server markup with the picture selected. */
  async function inspect(vault: MemoryVaultAdapter, picture: string) {
    const r = await renderer()
    await r.open(vault)
    r.s().select(imageKey(picture))
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Inspector } = await import('../src/components/Inspector')
    Object.assign(r.useAether.getInitialState(), r.useAether.getState())
    return { r, html: renderToStaticMarkup(createElement(Inspector)) }
  }
  const withVideo = (readOnly = false) =>
    new MemoryVaultAdapter([...vaultFiles(), { path: 'Inbox/Clip.md', content: '# Clip\n\n![[turntable.mp4]]\n' }], { readOnly, assets: [...assetFiles(), { path: 'Art/turntable.mp4', data: new Uint8Array(8) }] })

  it('offers the button for a picture', async () => {
    const { html } = await inspect(withVideo(), 'Art/gate.png')
    expect(html).toContain('Add to board ▾')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Add to board/)
  })

  it('does not offer it for a video, which a board does not hold', async () => {
    const { html } = await inspect(withVideo(), 'Art/turntable.mp4')
    expect(html).toContain('aria-label="Picture inspector"')
    expect(html).not.toContain('Add to board')
  })

  it('disables it in a read-only vault, and says why', async () => {
    const { html } = await inspect(withVideo(true), 'Art/gate.png')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add to board/)
    expect(html).toContain('This vault is read-only')
  })

  it('lists the boards, the newest first, and a way to make a new one', async () => {
    const r = await renderer()
    await r.open(vault())
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { AddToBoardMenu } = await import('../src/components/Inspector')
    const html = renderToStaticMarkup(createElement(AddToBoardMenu, { path: 'Art/sky.png', onDone: () => undefined }))
    expect(html).toContain('role="menu"')
    expect(html.indexOf('Gate reference')).toBeGreaterThan(-1)
    expect(html.indexOf('Gate reference')).toBeLessThan(html.indexOf('Armour'))
    expect(html).toContain('＋ New board…')
    expect(html).not.toContain('more board')
  })

  it('shows only the first few boards and says how many more there are', async () => {
    const r = await renderer()
    const many = Array.from({ length: 11 }, (_, i): VaultFile => ({ path: `Boards/B${i}.md`, content: boardRaw(`B${i}`, [], `2026-09-${String(i + 1).padStart(2, '0')}`) }))
    await r.open(new MemoryVaultAdapter(many, { assets: assetFiles() }))
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { AddToBoardMenu, BOARD_CHOICES } = await import('../src/components/Inspector')
    const html = renderToStaticMarkup(createElement(AddToBoardMenu, { path: 'Art/sky.png', onDone: () => undefined }))
    expect(html.match(/role="menuitem"/g)).toHaveLength(BOARD_CHOICES + 1)
    expect(html).toContain('3 more boards in the Boards view (8)')
    // The newest are the ones listed.
    expect(html).toContain('>B10<')
    expect(html).not.toContain('>B0<')
  })
})
