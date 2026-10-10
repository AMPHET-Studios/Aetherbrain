import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, imageKey } from '@aether/core'
import type { ActiveBoard } from '../src/board/active'
import type { BoardCommandId, BoardUiState } from '../src/board/api'
import { BOARD_COMMANDS } from '../src/board/commands'
import { assetFiles, freshApp, vaultFiles } from './board-integration-harness'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fresh app with the vault open, the commands module of the same generation, and a fake open board. */
async function palette() {
  const app = await freshApp()
  const commands = await import('../src/commands')
  await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
  const selection: number[] = []
  const exec = vi.fn()
  const board: ActiveBoard = { path: 'Boards/Armour.md', exec, state: () => ({ selection }) as unknown as BoardUiState, flush: async () => undefined }
  return {
    ...app,
    commands,
    exec,
    select: (n: number) => void selection.splice(0, selection.length, ...Array.from({ length: n }, (_, i) => i + 1)),
    show: () => {
      app.active.setActiveBoard(board)
      app.s().openBoard('Boards/Armour.md')
    },
    ids: (q = '') => commands.findCommands(q, app.s()).map((c) => c.id),
    titles: (q = '') => commands.findCommands(q, app.s()).map((c) => c.title),
  }
}

/** The ids of the palette's board commands: every row of the table but the window's. */
const BOARD_IDS = BOARD_COMMANDS.filter((c) => !c.id.startsWith('window.'))

describe('the palette without a board', () => {
  it('offers to open the boards, to list them and to make one, but none of the board’s own commands', async () => {
    const p = await palette()
    const titles = p.titles()
    expect(titles).toContain('Boards: open')
    expect(titles).toContain('Boards: show list')
    expect(titles).toContain('Boards: new board')
    expect(p.ids().filter((id) => id.startsWith('board-'))).toEqual([])
    expect(p.titles('Board: ')).toEqual([])
  })

  it('does not offer them while the board is not the view, even if one is registered', async () => {
    const p = await palette()
    p.show()
    p.s().setView('graph')
    expect(p.ids().filter((id) => id.startsWith('board-'))).toEqual([])
  })

  it('does not offer to make a board in a read-only vault', async () => {
    const app = await freshApp()
    const commands = await import('../src/commands')
    await app.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true }))
    const ids = commands.findCommands('', app.s()).map((c) => c.id)
    expect(ids).not.toContain('boards-new')
    expect(ids).toContain('boards-open')
  })
})

describe('the palette with a board open', () => {
  it('offers every command of the table but the window’s, as “Board: …”', async () => {
    const p = await palette()
    p.show()
    p.select(3)
    const titles = new Set(p.titles())
    for (const c of BOARD_IDS) {
      if (c.id === 'picture.reveal') continue
      expect(titles.has(`Board: ${c.title}`), c.id).toBe(true)
    }
    expect(BOARD_IDS.length).toBeGreaterThan(70)
  })

  it('takes the keys from the table, so the palette shows what the board does', async () => {
    const p = await palette()
    const all = p.commands.COMMANDS
    for (const c of BOARD_IDS) {
      const cmd = all.find((x) => x.id === `board-${c.id}`)!
      expect(cmd.keys, c.id).toBe(c.keys)
      expect(cmd.title).toBe(`Board: ${c.title}`)
    }
  })

  it('offers a command only when enough is selected for it', async () => {
    const p = await palette()
    p.show()
    for (let n = 0; n <= 4; n++) {
      p.select(n)
      const offered = new Set(p.ids())
      for (const c of BOARD_IDS) {
        if (c.id === 'picture.reveal') continue
        expect(offered.has(`board-${c.id}`), `${c.id} with ${n} selected`).toBe(n >= (c.needs ?? 0))
      }
    }
  })

  it('has no “Show in the file manager” for a vault that cannot', async () => {
    const p = await palette()
    p.show()
    p.select(1)
    expect(p.ids()).not.toContain('board-picture.reveal')
  })

  it('has it for a vault that can', async () => {
    const app = await freshApp()
    const commands = await import('../src/commands')
    class Reveals extends MemoryVaultAdapter {
      async reveal(): Promise<void> {}
    }
    await app.open(new Reveals(vaultFiles(), { assets: assetFiles() }))
    app.active.setActiveBoard({ path: 'Boards/Armour.md', exec: () => undefined, state: () => ({ selection: [1] }) as unknown as BoardUiState, flush: async () => undefined })
    app.s().openBoard('Boards/Armour.md')
    expect(commands.findCommands('', app.s()).map((c) => c.id)).toContain('board-picture.reveal')
  })

  it('leaves the window’s commands to the desktop app, which has its own', async () => {
    const p = await palette()
    p.show()
    p.select(1)
    expect(p.ids().filter((id) => id.includes('window'))).toEqual([])
    for (const t of BOARD_COMMANDS.filter((c) => c.id.startsWith('window.')).map((c) => `Board: ${c.title}`)) expect(p.titles()).not.toContain(t)
  })

  it('runs a command on the open board, by its id', async () => {
    const p = await palette()
    p.show()
    p.select(2)
    for (const c of BOARD_IDS) {
      p.exec.mockClear()
      const cmd = p.commands.findCommands('', p.s()).find((x) => x.id === `board-${c.id}`)
      if (!cmd) continue
      cmd.run(p.s())
      expect(p.exec, c.id).toHaveBeenCalledTimes(1)
      expect(p.exec.mock.calls[0]![0] as BoardCommandId).toBe(c.id)
    }
  })

  it('does nothing when the board has gone by the time the command runs', async () => {
    const p = await palette()
    p.show()
    const cmd = p.commands.findCommands('', p.s()).find((x) => x.id === 'board-edit.selectAll')!
    p.active.setActiveBoard(null)
    expect(() => cmd.run(p.s())).not.toThrow()
    expect(p.exec).not.toHaveBeenCalled()
  })

  it('finds a command by what it is called', async () => {
    const p = await palette()
    p.show()
    p.select(1)
    expect(p.titles('board: undo')).toEqual(['Board: Undo'])
    expect(p.ids('flip h')).toEqual(['board-transform.flipH'])
    expect(p.ids('board-sort.')).toEqual(['board-sort.name', 'board-sort.added', 'board-sort.size', 'board-sort.shuffle'])
  })
})

describe('no entry is listed twice', () => {
  it('ids and titles are unique across the app’s commands, with a board open', async () => {
    const p = await palette()
    p.show()
    p.select(3)
    const ids = p.ids()
    const titles = p.titles()
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('the desktop app’s four window entries do not repeat a title of the UI package', async () => {
    const src = readFileSync(new URL('../../../apps/desktop/src/renderer/board.ts', import.meta.url), 'utf8')
    const desktop = [...src.matchAll(/^\s+title: '([^']+)',$/gm)].map((m) => m[1]!)
    expect(desktop.length).toBeGreaterThanOrEqual(4)
    const p = await palette()
    const ours = new Set(p.commands.COMMANDS.map((c) => c.title))
    for (const t of desktop) expect(ours.has(t), t).toBe(false)
    const ids = [...src.matchAll(/^\s+id: '([^']+)',$/gm)].map((m) => m[1]!)
    const ourIds = new Set(p.commands.COMMANDS.map((c) => c.id))
    for (const id of ids) expect(ourIds.has(id), id).toBe(false)
  })
})

describe('the entries that open and make boards', () => {
  it('open the boards the way 8 does', async () => {
    const p = await palette()
    p.commands.COMMANDS.find((c) => c.id === 'boards-open')!.run(p.s())
    expect(p.s()).toMatchObject({ view: 'boards', boardPath: null })
    p.s().openBoard('Boards/Armour.md')
    p.s().setView('graph')
    p.commands.COMMANDS.find((c) => c.id === 'boards-open')!.run(p.s())
    expect(p.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Armour.md' })
  })

  it('show the list from a board', async () => {
    const p = await palette()
    p.s().openBoard('Boards/Armour.md')
    p.commands.COMMANDS.find((c) => c.id === 'boards-list')!.run(p.s())
    expect(p.s()).toMatchObject({ view: 'boards', boardPath: null })
  })

  it('ask the list for its new-board form', async () => {
    const p = await palette()
    p.s().openBoard('Boards/Armour.md')
    p.commands.COMMANDS.find((c) => c.id === 'boards-new')!.run(p.s())
    expect(p.s()).toMatchObject({ view: 'boards', boardPath: null, formRequest: 'board' })
  })

  it('open a selected note that is a board, and only then', async () => {
    const p = await palette()
    const cmd = () => p.commands.findCommands('', p.s()).find((c) => c.id === 'boards-open-selected')
    p.s().select('Inbox/Idea')
    expect(cmd()).toBeUndefined()
    p.s().select('Boards/Gate reference')
    expect(cmd()).toBeDefined()
    cmd()!.run(p.s())
    expect(p.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Gate reference.md' })
  })

  it('put the selected picture on the last board, or on a new one', async () => {
    const p = await palette()
    const find = (id: string) => p.commands.findCommands('', p.s()).find((c) => c.id === id)
    p.s().select(imageKey('Art/sky.png'))
    // No board has been used yet: nothing to add to, but a new board can be made.
    expect(find('boards-add-picture')).toBeUndefined()
    expect(find('boards-add-picture-new')).toBeDefined()
    const made = vi.spyOn(p.s(), 'newBoard')
    await find('boards-add-picture-new')!.run(p.s())
    expect(made).toHaveBeenCalledWith('sky reference', { open: false })
    expect(p.s().boards().map((b) => b.meta.path)).toContain('Boards/sky reference.md')
    // The board stays closed and the picture is on it.
    expect(p.s().view).toBe('graph')
    expect(p.s().notes.get('Boards/sky reference')!.raw).toContain('![[Art/sky.png]]')

    p.s().openBoard('Boards/Armour.md')
    p.s().setView('graph')
    p.s().select(imageKey('Art/ring.png'))
    expect(find('boards-add-picture')).toBeDefined()
    await find('boards-add-picture')!.run(p.s())
    expect(p.s().notes.get('Boards/Armour')!.raw).toContain('![[Art/ring.png]]')
  })

  it('are not offered for a note, and a read-only vault cannot add', async () => {
    const p = await palette()
    p.s().select('Inbox/Idea')
    expect(p.ids()).not.toContain('boards-add-picture-new')
    const app = await freshApp()
    const commands = await import('../src/commands')
    await app.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true, assets: assetFiles() }))
    app.s().select(imageKey('Art/sky.png'))
    expect(commands.findCommands('', app.s()).map((c) => c.id)).not.toContain('boards-add-picture-new')
  })
})
