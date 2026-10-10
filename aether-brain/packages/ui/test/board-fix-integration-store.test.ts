import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_LIMITS, MemoryVaultAdapter, addNote, boardChars, boardPictures, emptyBoard, imageKey, newBoardNote, parseBoard, serializeBoard, type VaultFile } from '@aether/core'
import { PNG, boardRaw, freshApp, vaultFiles } from './board-integration-harness'

// The first test loads the whole UI package, which takes seconds on a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NOW = new Date('2026-10-10T10:00:00')
const manyAssets = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `Art/n${i}.png`, data: PNG, mtime: 1000 + i }))
const vault = (files: VaultFile[] = vaultFiles(), assets = manyAssets(3)) => new MemoryVaultAdapter(files, { assets: [...assets, { path: 'Art/clip.mp4', data: PNG, mtime: 900 }] })
const toastTexts = (app: Awaited<ReturnType<typeof freshApp>>) => app.s().toasts.map((t) => t.text)

/** A board of long notes that has about `room` characters of its budget left. */
function heavyBoard(title: string, room: number): string {
  let doc = emptyBoard(title)
  const target = BOARD_LIMITS.noteTotal - room
  let i = 0
  while (boardChars(doc) + 4400 < target) doc = addNote(doc, { text: 'x'.repeat(BOARD_LIMITS.noteChars), x: (i++ % 20) * 600, y: Math.floor(i / 20) * 400 }).doc
  const gap = target - boardChars(doc)
  if (gap > 400) doc = addNote(doc, { text: 'x'.repeat(gap - 300), x: 0, y: -400 }).doc
  return serializeBoard(doc, newBoardNote(title, NOW), NOW)
}

describe('pictures onto a board close to its budget (format-1, shell-7)', () => {
  it('adds as many as fit, and says the board is full with the budget in the message', async () => {
    const app = await freshApp()
    const v = await app.open(vault([{ path: 'Boards/Heavy.md', content: heavyBoard('Heavy', 1500) }], manyAssets(150)))
    const paths = Array.from({ length: 150 }, (_, i) => `Art/n${i}.png`)
    const added = await app.s().addPicturesToBoard(paths, 'Boards/Heavy.md')
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThan(150)
    const after = parseBoard((await v.read('Boards/Heavy.md'))!).doc
    expect(boardChars(after)).toBeLessThanOrEqual(BOARD_LIMITS.noteTotal)
    expect(boardPictures(after)).toHaveLength(added)
    const toast = app.s().toasts.at(-1)!
    expect(toast.kind).toBe('error')
    expect(toast.text).toContain('Heavy is full')
    expect(toast.text).toContain(`added ${added} pictures`)
    expect(toast.text).toContain('500,000 characters of items')
  })

  it('adds nothing to a board over its budget, writes nothing, and says why', async () => {
    const app = await freshApp()
    const raw = heavyBoard('Over', -20_000)
    const v = await app.open(vault([{ path: 'Boards/Over.md', content: raw }], manyAssets(5)))
    const write = vi.spyOn(v, 'write')
    expect(await app.s().addPicturesToBoard(['Art/n0.png', 'Art/n1.png'], 'Boards/Over.md')).toBe(0)
    expect(write).not.toHaveBeenCalled()
    expect(await v.read('Boards/Over.md')).toBe(raw)
    expect(toastTexts(app).at(-1)).toMatch(/Over is full: it holds at most about 500,000 characters of items/)
  })

  it('still says "1,500 items" when it is the item limit that stops it, and takes everything with room to spare', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(await app.s().addPicturesToBoard(['Art/n0.png', 'Art/n1.png'], 'Boards/Armour.md')).toBe(2)
    expect(app.s().toasts.at(-1)!.kind).toBe('success')
  })
})

describe('a view that cannot save blocks what would rewrite the note under it (desktop-2, store half)', () => {
  it('adds nothing, writes nothing and says why when the open board could not be flushed', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const flush = vi.fn(async () => false)
    app.active.setActiveBoard({ path: 'Boards/Armour.md', exec: () => undefined, state: () => ({}) as never, flush })
    const write = vi.spyOn(v, 'write')
    const before = await v.read('Boards/Armour.md')
    expect(await app.s().addPicturesToBoard(['Art/n0.png'], 'Boards/Armour.md')).toBe(0)
    expect(flush).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(await v.read('Boards/Armour.md')).toBe(before)
    const toast = app.s().toasts.at(-1)!
    expect(toast.kind).toBe('error')
    expect(toast.text).toMatch(/Armour could not be saved first, so the pictures were not added/)
  })

  it('goes on when the flush says everything is written', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    app.active.setActiveBoard({ path: 'Boards/Armour.md', exec: () => undefined, state: () => ({}) as never, flush: async () => true })
    expect(await app.s().addPicturesToBoard(['Art/n0.png'], 'Boards/Armour.md')).toBe(1)
    expect(boardPictures(parseBoard((await v.read('Boards/Armour.md'))!).doc)).toEqual(['Art/n0.png'])
  })

  it('does not ask a board that is not open in the view', async () => {
    const app = await freshApp()
    await app.open(vault())
    const flush = vi.fn(async () => false)
    app.active.setActiveBoard({ path: 'Boards/Gate reference.md', exec: () => undefined, state: () => ({}) as never, flush })
    expect(await app.s().addPicturesToBoard(['Art/n0.png'], 'Boards/Armour.md')).toBe(1)
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('saving a board the view never read (integration-m7)', () => {
  it('refuses to turn an ordinary note into a board, and writes nothing', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const write = vi.spyOn(v, 'write')
    const before = await v.read('Inbox/Idea.md')
    await expect(app.s().saveBoard('Inbox/Idea.md', boardRaw('Idea'), null)).rejects.toThrow(/Idea is not a board/)
    expect(write).not.toHaveBeenCalled()
    expect(await v.read('Inbox/Idea.md')).toBe(before)
  })

  it('still writes a board it is told nothing was expected of', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const next = boardRaw('Armour', ['Art/n0.png'], '2026-10-09')
    await app.s().saveBoard('Boards/Armour.md', next, null)
    expect(await v.read('Boards/Armour.md')).toBe(next)
  })

  it('answers an outside edit that removed the type with the changed-outside refusal, not the ordinary-note one', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const was = (await app.s().readBoard('Boards/Armour.md'))!
    await v.write('Boards/Armour.md', was.replace('type: board\n', ''))
    await expect(app.s().saveBoard('Boards/Armour.md', boardRaw('Armour', ['Art/n0.png']), was)).rejects.toBeInstanceOf(app.registry.BoardChangedOutsideError)
  })
})

describe('the last board follows a rename (integration-m9 c)', () => {
  it('rewrites the key the 8 key reads after a restart', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    expect(app.storage.getItem('aether:board:memory://')).toBe('Boards/Armour.md')
    await app.s().renameNote('Boards/Armour', 'Boards/Plate armour.md')
    expect(app.storage.getItem('aether:board:memory://')).toBe('Boards/Plate armour.md')
    const next = await freshApp({ 'aether:board:memory://': app.storage.getItem('aether:board:memory://')! })
    await next.open(vault([{ path: 'Boards/Plate armour.md', content: boardRaw('Plate armour') }]))
    next.s().openBoards()
    expect(next.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Plate armour.md' })
  })

  it('follows a board that is only the last one (closed), too', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    app.s().closeBoard()
    await app.s().renameNote('Boards/Armour', 'Boards/Plate armour.md')
    expect(app.s().lastBoardPath).toBe('Boards/Plate armour.md')
    expect(app.storage.getItem('aether:board:memory://')).toBe('Boards/Plate armour.md')
  })

  it('leaves the key alone when another note is renamed', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    await app.s().renameNote('Inbox/Idea', 'Inbox/Notion.md')
    expect(app.storage.getItem('aether:board:memory://')).toBe('Boards/Armour.md')
  })
})

describe('showing a node leaves any covering view (integration-m1)', () => {
  for (const view of ['boards', 'projects', 'review', 'capture'] as const) {
    it(`from ${view}: the view is the graph and the note is selected`, async () => {
      const app = await freshApp()
      await app.open(vault())
      app.s().setView(view)
      app.s().showNode('Inbox/Idea')
      expect(app.s().view).toBe('graph')
      expect(app.s().selectedId).toBe('Inbox/Idea')
    })
  }

  it('does not change a view that does not cover the graph', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openNote('Inbox/Idea', { fly: false })
    expect(app.s().view).toBe('editor')
    app.s().showNode('Boards/Armour')
    expect(app.s().view).toBe('editor')
  })
})

describe('the palette offers a board no video (integration-m9 a)', () => {
  it('hides "add the selected picture" for a video, and shows it for a picture', async () => {
    const app = await freshApp()
    await app.open(vault())
    const commands = await import('../src/commands')
    const ids = ['boards-add-picture', 'boards-add-picture-new']
    for (const id of ids) {
      const cmd = commands.COMMANDS.find((c) => c.id === id)!
      expect(cmd.when!({ ...app.s(), selectedId: imageKey('Art/n0.png'), lastBoardPath: 'Boards/Armour.md' })).toBe(true)
      expect(cmd.when!({ ...app.s(), selectedId: imageKey('Art/clip.mp4'), lastBoardPath: 'Boards/Armour.md' })).toBe(false)
    }
  })
})
