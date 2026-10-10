import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, boardPictures, isBoardNote, parseBoard, imageKey, type VaultFile } from '@aether/core'
import { DesktopLikeVault, PNG, TwoRoots, assetFiles, boardRaw, freshApp, vaultFiles } from './board-integration-harness'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const vault = (files: VaultFile[] = vaultFiles()) => new MemoryVaultAdapter(files, { assets: assetFiles() })
const toastTexts = (app: Awaited<ReturnType<typeof freshApp>>) => app.s().toasts.map((t) => t.text)

describe('listing boards', () => {
  it('lists the notes whose frontmatter type is board, the most recently updated first', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(app.s().boards().map((n) => n.meta.path)).toEqual(['Boards/Gate reference.md', 'Boards/Armour.md'])
    expect(app.s().boards().every((n) => n.frontmatter['type'] === 'board')).toBe(true)
  })

  it('does not take a note that only talks about boards, nor a type of another case, nor broken frontmatter', async () => {
    const app = await freshApp()
    await app.open(
      vault([
        ...vaultFiles(),
        { path: 'Inbox/About boards.md', content: '---\ntitle: About boards\ntype: note\n---\n# About boards\n\ntype: board\n' },
        { path: 'Inbox/Loud.md', content: '---\ntitle: Loud\ntype: Board\n---\n# Loud\n' },
        { path: 'Inbox/Broken.md', content: '---\ntitle: [oops\ntype: board\n---\n# Broken\n' },
      ]),
    )
    expect(app.s().boards().map((n) => n.meta.title)).toEqual(['Gate reference', 'Armour'])
  })

  it('follows the vault: a board made, changed or deleted outside shows up in the list', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    v.external([{ kind: 'add', path: 'Boards/New.md', content: boardRaw('New', [], '2026-10-09') }])
    expect(app.s().boards()[0]!.meta.title).toBe('New')
    v.external([{ kind: 'unlink', path: 'Boards/New.md' }])
    expect(app.s().boards().map((n) => n.meta.title)).toEqual(['Gate reference', 'Armour'])
  })
})

describe('making a board', () => {
  it('creates <home>Boards/<Title>.md with the board format and opens it', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const path = await app.s().newBoard('Castle ruins')
    expect(path).toBe('Boards/Castle ruins.md')
    const raw = (await v.read(path!))!
    expect(isBoardNote(raw)).toBe(true)
    expect(parseBoard(raw).doc.title).toBe('Castle ruins')
    expect(app.s().notes.get('Boards/Castle ruins')?.frontmatter['type']).toBe('board')
    expect(app.s()).toMatchObject({ boardPath: path, lastBoardPath: path, view: 'boards' })
  })

  it('names an unnamed board, and makes the name a file name every system takes', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(await app.s().newBoard()).toBe('Boards/Reference board.md')
    expect(await app.s().newBoard('  ')).toBe('Boards/Reference board 2.md')
    expect(await app.s().newBoard('Gate: ring / lock? #1')).toBe('Boards/Gate ring lock 1.md')
    expect(await app.s().newBoard('.hidden')).toBe('Boards/hidden.md')
  })

  it('gives a second board of the same name a number, in its file name and its title, and never replaces a board', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const first = await app.s().newBoard('Gate reference')
    expect(first).toBe('Boards/Gate reference 2.md')
    expect(parseBoard((await v.read(first!))!).doc.title).toBe('Gate reference 2')
    const third = await app.s().newBoard('Gate reference')
    expect(third).toBe('Boards/Gate reference 3.md')
    // The first board of that name is untouched.
    expect(parseBoard((await v.read('Boards/Gate reference.md'))!).doc.title).toBe('Gate reference')
  })

  it('does not take the title of any other note either (links and search find notes by title)', async () => {
    const app = await freshApp()
    await app.open(vault())
    // Projects/Gate.md is titled Gate.
    expect(await app.s().newBoard('Gate')).toBe('Boards/Gate 2.md')
    expect(await app.s().newBoard('idea')).toBe('Boards/idea 2.md')
  })

  it('uses the Boards folder as the vault spells it, and the first drive of a vault of several', async () => {
    const app = await freshApp()
    await app.open(new MemoryVaultAdapter([{ path: 'boards/Old.md', content: boardRaw('Old') }]))
    expect(await app.s().newBoard('Fresh')).toBe('boards/Fresh.md')

    const two = await freshApp()
    await two.open(new TwoRoots([{ path: 'D/Notes/a.md', content: '# a\n' }]))
    expect(await two.s().newBoard('Fresh')).toBe('D/Boards/Fresh.md')
  })

  it('can leave the view alone (a picture is going onto it)', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().setView('graph')
    const path = await app.s().newBoard('Quiet', { open: false })
    expect(path).toBe('Boards/Quiet.md')
    expect(app.s()).toMatchObject({ boardPath: null, view: 'graph' })
    expect(toastTexts(app)).toEqual([])
  })

  it('refuses without a vault, and in a read-only one, saying why', async () => {
    const app = await freshApp()
    expect(await app.s().newBoard('x')).toBeNull()
    expect(toastTexts(app)).toEqual(['Open a vault first to make a board'])
    await app.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true }))
    expect(await app.s().newBoard('x')).toBeNull()
    expect(toastTexts(app).at(-1)).toBe('This vault is read-only')
  })
})

describe('opening and leaving boards', () => {
  it('opens a board of the vault, whatever the letter case of the path', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('boards/gate REFERENCE.md')
    expect(app.s()).toMatchObject({ boardPath: 'Boards/Gate reference.md', view: 'boards' })
  })

  it('refuses a path that is not a board of the vault, and changes nothing', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Inbox/Idea.md')
    app.s().openBoard('Boards/Nope.md')
    expect(app.s()).toMatchObject({ boardPath: null, view: 'graph' })
    expect(toastTexts(app)).toEqual(['Inbox/Idea.md is not a board of this vault', 'Boards/Nope.md is not a board of this vault'])
  })

  it('goes back to the list and remembers the board; the list stays the view', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    app.s().closeBoard()
    expect(app.s()).toMatchObject({ boardPath: null, lastBoardPath: 'Boards/Armour.md', view: 'boards' })
  })

  it('remembers the last board per vault, in the browser, for the next session', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    expect(app.storage.getItem('aether:board:memory://')).toBe('Boards/Armour.md')
    const next = await freshApp({ 'aether:board:memory://': 'Boards/Armour.md' })
    await next.open(vault())
    expect(next.s()).toMatchObject({ boardPath: null, lastBoardPath: 'Boards/Armour.md' })
    next.s().openBoards()
    expect(next.s()).toMatchObject({ boardPath: 'Boards/Armour.md', view: 'boards' })
  })

  it('8 from another view: the board last open, else the list; a board that is gone is not opened', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    app.s().openBoards()
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: null })
    app.s().openBoard('Boards/Armour.md')
    app.s().setView('graph')
    app.s().openBoards()
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Armour.md' })
    app.s().setView('graph')
    await v.remove('Boards/Armour.md')
    app.s().openBoards()
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: null })
  })

  it('8 inside the view is up: the board to the list, the list back to the board', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    app.s().openBoards()
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: null, lastBoardPath: 'Boards/Armour.md' })
    app.s().openBoards()
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Armour.md' })
  })

  it('the new-board form is asked for on the list, and other forms leave the view', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    app.s().requestForm('board')
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: null, formRequest: 'board' })
    app.s().requestForm('note')
    expect(app.s().view).toBe('graph')
  })

  it('a board renamed while open stays open under its new name', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    await app.s().renameNote('Boards/Armour', 'Boards/Plate armour.md')
    expect(app.s()).toMatchObject({ boardPath: 'Boards/Plate armour.md', lastBoardPath: 'Boards/Plate armour.md' })
  })

  it('another vault opens with no board', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    await app.open(new MemoryVaultAdapter([{ path: 'A.md', content: '# A\n' }], { location: 'memory://other' }))
    expect(app.s().boardPath).toBeNull()
    expect(app.s().lastBoardPath).toBeNull()
  })

  it('the view is a covering view: showing a node leaves it', async () => {
    const app = await freshApp()
    await app.open(vault())
    app.s().openBoard('Boards/Armour.md')
    app.s().showPicture('Art/sky.png')
    expect(app.s().view).toBe('graph')
    expect(app.s().selectedId).toBe(imageKey('Art/sky.png'))
  })
})

describe('where a board keeps its pictures', () => {
  it('is the folder next to the note named like the file', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(app.s().boardFolderOf('Boards/Gate reference.md')).toBe('Boards/Gate reference')
    expect(app.s().boardFolderOf('Gate.md')).toBe('Gate')
    expect(app.s().boardFolderOf('D/Boards/Gate#1.md')).toBe('D/Boards/Gate-1')
  })

  it('is a folder the vault looks into: a name it ignores gets pictures after it', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(app.s().boardFolderOf('Boards/Library.md')).toBe('Boards/Library pictures')
    expect(app.s().boardFolderOf('Boards/Temp.md')).toBe('Boards/Temp pictures')
  })
})

describe('putting pictures on a board that is not open', () => {
  it('rewrites the note: the pictures are packed to the right of what is there, everything else stays as written', async () => {
    const app = await freshApp()
    const hand = '\n## Notes\n\nA line I wrote myself, with [[Gate]] in it.\n'
    const raw = boardRaw('Gate reference', ['Art/gate.png', 'Art/ring.png'], '2026-10-03') + hand
    const v = await app.open(vault([{ path: 'Boards/Gate reference.md', content: raw }, { path: 'Projects/Gate.md', content: '# Gate\n' }]))
    const added = await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Gate reference.md')
    expect(added).toBe(1)
    const after = (await v.read('Boards/Gate reference.md'))!
    expect(after.endsWith(hand)).toBe(true)
    const doc = parseBoard(after).doc
    expect(boardPictures(doc)).toEqual(['Art/gate.png', 'Art/ring.png', 'Art/sky.png'])
    const [gate, ring, sky] = doc.items.filter((i) => i.kind === 'picture')
    expect(sky!.x - 0).toBeGreaterThan(Math.max(gate!.x, ring!.x))
    // The brain links the board to its pictures through the embeds.
    expect(app.s().graph!.outlinks.get('Boards/Gate reference')?.has(imageKey('Art/sky.png'))).toBe(true)
  })

  it('does not add a picture twice, and says so', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const before = await v.read('Boards/Gate reference.md')
    expect(await app.s().addPicturesToBoard(['Art/gate.png'], 'Boards/Gate reference.md')).toBe(0)
    expect(await v.read('Boards/Gate reference.md')).toBe(before)
    expect(toastTexts(app).at(-1)).toBe('That picture is already on Gate reference')
  })

  it('adds several at once, skipping the ones already there and the ones that are no pictures of the vault', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const n = await app.s().addPicturesToBoard(['Art/gate.png', 'Art/sky.png', 'Art/missing.png', 'Inbox/Idea.md', 'Art/sky.png'], 'Boards/Gate reference.md')
    expect(n).toBe(1)
    expect(boardPictures(parseBoard((await v.read('Boards/Gate reference.md'))!).doc)).toEqual(['Art/gate.png', 'Art/ring.png', 'Art/sky.png'])
    expect(toastTexts(app).at(-1)).toBe('Added sky.png to Gate reference (1 already there)')
  })

  it('shows an empty board its first pictures: centred, and the view fitted to them', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    await app.s().addPicturesToBoard(['Art/gate.png', 'Art/ring.png', 'Art/sky.png'], 'Boards/Armour.md')
    const doc = parseBoard((await v.read('Boards/Armour.md'))!).doc
    expect(doc.items).toHaveLength(3)
    // Not a view at the origin at zoom 1: fitted to three 400 px pictures in a 1200 by 760 view.
    expect(doc.view.zoom).not.toBe(1)
    expect(Math.abs(doc.view.x)).toBeLessThan(5)
  })

  it('offers to open the board in the toast, and the toast’s button does', async () => {
    const app = await freshApp()
    await app.open(vault())
    await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')
    const toast = app.s().toasts.at(-1)!
    expect(toast.text).toBe('Added sky.png to Armour')
    expect(toast.action?.label).toBe('Open')
    toast.action!.run()
    expect(app.s()).toMatchObject({ view: 'boards', boardPath: 'Boards/Armour.md' })
  })

  it('goes to the board open or last open when none is named', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    expect(await app.s().addPicturesToBoard(['Art/sky.png'])).toBe(0)
    expect(toastTexts(app).at(-1)).toBe('Open or make a board first (8), then add pictures to it')
    app.s().openBoard('Boards/Armour.md')
    app.s().closeBoard()
    expect(await app.s().addPicturesToBoard(['Art/sky.png'])).toBe(1)
    expect(boardPictures(parseBoard((await v.read('Boards/Armour.md'))!).doc)).toEqual(['Art/sky.png'])
  })

  it('refuses what is not a board, a vault that is read-only, and pictures the vault does not have', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(await app.s().addPicturesToBoard(['Art/sky.png'], 'Inbox/Idea.md')).toBe(0)
    expect(toastTexts(app).at(-1)).toBe('Inbox/Idea.md is not a board of this vault')
    expect(await app.s().addPicturesToBoard(['Art/missing.png'], 'Boards/Armour.md')).toBe(0)
    expect(toastTexts(app).at(-1)).toBe('Only pictures of the vault can go on a board')
    expect(await app.s().addPicturesToBoard([], 'Boards/Armour.md')).toBe(0)
    expect(toastTexts(app).at(-1)).toBe('Select a picture first')

    const ro = await freshApp()
    await ro.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true, assets: assetFiles() }))
    expect(await ro.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')).toBe(0)
    expect(toastTexts(ro).at(-1)).toBe('This vault is read-only')
  })

  it('gives each picture the shape it has: read from a small preview, a few at a time', async () => {
    vi.stubGlobal('createImageBitmap', async (b: Blob) => ({ width: b.size, height: 50, close() {} }))
    let busy = 0
    let most = 0
    class Slow extends MemoryVaultAdapter {
      override async thumbnail(path: string, size: number): Promise<Blob | null> {
        busy++
        most = Math.max(most, busy)
        await new Promise((r) => setTimeout(r, 5))
        busy--
        return super.thumbnail(path, size)
      }
    }
    const data = (n: number) => new Uint8Array(n)
    const assets = [
      { path: 'Art/wide.png', data: data(200) },
      { path: 'Art/tall.png', data: data(25) },
      ...Array.from({ length: 8 }, (_, i) => ({ path: `Art/n${i}.png`, data: data(50) })),
    ]
    const app = await freshApp()
    const v = new Slow(vaultFiles(), { assets })
    await app.open(v)
    await app.s().addPicturesToBoard(['Art/wide.png', 'Art/tall.png', ...Array.from({ length: 8 }, (_, i) => `Art/n${i}.png`)], 'Boards/Armour.md')
    const items = parseBoard((await v.read('Boards/Armour.md'))!).doc.items.flatMap((i) => (i.kind === 'picture' ? [i] : []))
    const by = (p: string) => items.find((i) => i.path === p)!
    expect(by('Art/wide.png').w / by('Art/wide.png').h).toBeCloseTo(4)
    expect(Math.max(by('Art/wide.png').w, by('Art/wide.png').h)).toBeCloseTo(400)
    expect(by('Art/tall.png').w / by('Art/tall.png').h).toBeCloseTo(0.5)
    expect(by('Art/n3.png').w / by('Art/n3.png').h).toBeCloseTo(1)
    expect(items).toHaveLength(10)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(4)
  })

  it('leaves a board that is open in the floating window to that window, and says so', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const status = { open: true, path: 'boards/ARMOUR.md', alwaysOnTop: true, opacity: 1, supportsOpacity: true }
    app.active.setBoardWindowControl({
      available: true,
      status: () => status,
      subscribe: () => () => undefined,
      popOut: async () => true,
      dock: async () => undefined,
      setAlwaysOnTop: async () => undefined,
      setOpacity: async () => undefined,
      onReturned: () => () => undefined,
      setFlush: () => () => undefined,
    })
    const before = await v.read('Boards/Armour.md')
    expect(await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')).toBe(0)
    expect(await v.read('Boards/Armour.md')).toBe(before)
    expect(toastTexts(app).at(-1)).toMatch(/^Armour is open in its own window/)
    // Another board is not the window's.
    expect(await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Gate reference.md')).toBe(1)
    // And once the window has given it back it takes pictures again.
    status.open = false
    expect(await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')).toBe(1)
  })

  it('saves a board that is open in the view first, and adds to what the view saved', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const order: string[] = []
    // The view's pending change: a title edit it writes when asked to flush.
    app.active.setActiveBoard({
      path: 'Boards/Armour.md',
      exec: () => undefined,
      state: () => ({}) as never,
      flush: async () => {
        order.push('flush')
        const disk = (await v.read('Boards/Armour.md'))!
        await v.write('Boards/Armour.md', disk + '\nWritten by the view while open.\n')
        order.push('flushed')
      },
    })
    const n = await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')
    expect(n).toBe(1)
    expect(order).toEqual(['flush', 'flushed'])
    const after = (await v.read('Boards/Armour.md'))!
    expect(after).toContain('Written by the view while open.')
    expect(boardPictures(parseBoard(after).doc)).toEqual(['Art/sky.png'])
    // The view reloads by itself: no "Open" button for a board already in front of the user.
    expect(app.s().toasts.at(-1)!.action).toBeUndefined()
  })

  it('runs after a rewrite of the same note that is under way (the exclusive queue), and loses neither', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const slow = app.s().patchFrontmatter('Boards/Armour', { status: 'active' })
    const fast = app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')
    await Promise.all([slow, fast])
    const after = (await v.read('Boards/Armour.md'))!
    expect(after).toMatch(/status: active/)
    expect(boardPictures(parseBoard(after).doc)).toEqual(['Art/sky.png'])
  })
})

describe('reading and saving a board for the view', () => {
  it('reads the note as it is on disk, a change the watcher has not reported yet included', async () => {
    const app = await freshApp()
    class Quiet extends MemoryVaultAdapter {
      override watch(): () => void {
        return () => {}
      }
    }
    const v = new Quiet(vaultFiles(), { assets: assetFiles() })
    await app.open(v)
    await v.write('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']))
    expect(await app.s().readBoard('Boards/Armour.md')).toBe(boardRaw('Armour', ['Art/sky.png']))
    expect(app.s().notes.get('Boards/Armour')!.raw).toBe(boardRaw('Armour', ['Art/sky.png']))
  })

  it('does not read what is no board, or is gone, and says which', async () => {
    const app = await freshApp()
    await app.open(vault())
    expect(await app.s().readBoard('Inbox/Idea.md')).toBeNull()
    expect(await app.s().readBoard('Boards/Nope.md')).toBeNull()
    expect(toastTexts(app)).toEqual(['Idea is not a board (its frontmatter has no type: board)', 'Could not open the board: Boards/Nope.md is not in the vault'])
  })

  it('writes the board, and the store has the new text at once', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const was = (await app.s().readBoard('Boards/Armour.md'))!
    const next = boardRaw('Armour', ['Art/sky.png'], '2026-10-09')
    await app.s().saveBoard('Boards/Armour.md', next, was)
    expect(await v.read('Boards/Armour.md')).toBe(next)
    expect(app.s().notes.get('Boards/Armour')!.raw).toBe(next)
    expect(toastTexts(app)).toEqual([])
  })

  it('refuses to write over a note that is not the one the board was read from, and writes nothing', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const was = (await app.s().readBoard('Boards/Armour.md'))!
    await v.write('Boards/Armour.md', was + '\nTyped in an editor meanwhile.\n')
    const write = vi.spyOn(v, 'write')
    await expect(app.s().saveBoard('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']), was)).rejects.toThrow(/changed outside/)
    await expect(app.s().saveBoard('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']), was)).rejects.toBeInstanceOf(app.registry.BoardChangedOutsideError)
    expect(write).not.toHaveBeenCalled()
    expect(await v.read('Boards/Armour.md')).toContain('Typed in an editor meanwhile.')
  })

  it('does not call it a change when the note already holds the very text', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const next = boardRaw('Armour', ['Art/sky.png'], '2026-10-09')
    await v.write('Boards/Armour.md', next)
    const write = vi.spyOn(v, 'write')
    await app.s().saveBoard('Boards/Armour.md', next, boardRaw('Armour'))
    expect(write).not.toHaveBeenCalled()
  })

  it('writes without the check when it is told nothing was expected', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    await v.write('Boards/Armour.md', boardRaw('Armour', [], '2026-10-05'))
    await app.s().saveBoard('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']), null)
    expect(boardPictures(parseBoard((await v.read('Boards/Armour.md'))!).doc)).toEqual(['Art/sky.png'])
  })

  it('refuses text that is not a board, a note that is gone, a vault that is read-only and a note being edited', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    await expect(app.s().saveBoard('Boards/Armour.md', '# just text\n', null)).rejects.toThrow(/not a board/)
    await expect(app.s().saveBoard('Boards/Nope.md', boardRaw('Nope'), null)).rejects.toThrow(/gone from the vault/)
    // A draft typed in the editor is the user's: the board does not write over it.
    app.s().openNote('Boards/Armour', { fly: false })
    app.s().setDraft(app.s().draft + '\nhalf a sentence')
    await expect(app.s().saveBoard('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']), boardRaw('Armour'))).rejects.toThrow(/unsaved edits in the editor/)
    expect(await v.read('Boards/Armour.md')).toBe(boardRaw('Armour'))

    const ro = await freshApp()
    await ro.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true }))
    await expect(ro.s().saveBoard('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']), null)).rejects.toThrow(/read-only/)
  })

  it('saves one after the other: the second starts from what the first wrote', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const a = boardRaw('Armour', ['Art/sky.png'], '2026-10-06')
    const b = boardRaw('Armour', ['Art/sky.png', 'Art/gate.png'], '2026-10-07')
    const was = boardRaw('Armour')
    const first = app.s().saveBoard('Boards/Armour.md', a, was)
    // The second one expects what the first writes.
    const second = app.s().saveBoard('Boards/Armour.md', b, a)
    await Promise.all([first, second])
    expect(await v.read('Boards/Armour.md')).toBe(b)
  })

  it('reads a whole picture, or nothing', async () => {
    const app = await freshApp()
    await app.open(vault())
    const blob = await app.s().readPicture('Art/gate.png')
    expect(blob?.type).toBe('image/png')
    expect(blob?.size).toBe(PNG.length)
    expect(await app.s().readPicture('Art/missing.png')).toBeNull()
    expect(await app.s().readPicture('Inbox/Idea.md')).toBeNull()
  })
})

describe('pictures dropped on a board', () => {
  const file = (name: string, data: Uint8Array = PNG) => ({ name, data })

  it('importImages stays quiet when asked: nothing selected, no "Added" toast', async () => {
    const loud = await freshApp()
    await loud.open(vault())
    const a = await loud.s().importImages([file('new.png')], 'Boards/Gate reference')
    expect(a).toEqual(['Boards/Gate reference/new.png'])
    expect(loud.s().selectedId).toBe(imageKey('Boards/Gate reference/new.png'))
    expect(toastTexts(loud)).toEqual(['Added new.png to Boards/Gate reference'])

    const quiet = await freshApp()
    await quiet.open(vault())
    const b = await quiet.s().importImages([file('new.png')], 'Boards/Gate reference', { quiet: true })
    expect(b).toEqual(['Boards/Gate reference/new.png'])
    expect(quiet.s().selectedId).toBeNull()
    expect(toastTexts(quiet)).toEqual([])
  })

  it('importImages in quiet mode leaves refused files to the caller too', async () => {
    const app = await freshApp()
    await app.open(vault())
    const written = await app.s().importImages([file('notes.txt'), file('ok.png')], 'Boards/Gate reference', { quiet: true })
    expect(written).toEqual(['Boards/Gate reference/ok.png'])
    expect(toastTexts(app)).toEqual([])
    // The loud way still says so.
    await app.s().importImages([file('notes.txt')], 'Boards/Gate reference')
    expect(toastTexts(app)).toEqual(['notes.txt is not a picture (png, jpg, webp, gif, bmp, avif)'])
  })

  it('saves into the board’s own folder and answers for every file in the order given', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const paths = await app.s().importBoardPictures('Boards/Gate reference.md', [file('a.png'), file('notes.txt'), file('b.jpg'), file('huge.png', new Uint8Array(41 * 1024 * 1024))])
    expect(paths).toEqual(['Boards/Gate reference/a.png', null, 'Boards/Gate reference/b.jpg', null])
    expect(v.assetData('Boards/Gate reference/a.png')).toEqual(PNG)
    expect(app.s().assets.has('Boards/Gate reference/b.jpg')).toBe(true)
    expect(app.s().selectedId).toBeNull()
    // The board says nothing about the files it cannot take: the view reports those.
    expect(toastTexts(app)).toEqual([])
  })

  it('a taken name gets the next number, and one graph rebuild serves the whole batch', async () => {
    const app = await freshApp()
    await app.open(vault())
    const before = app.s().revision
    const paths = await app.s().importBoardPictures('Boards/Gate reference.md', [file('ref.png'), file('ref.png'), file('ref.png')])
    expect(paths).toEqual(['Boards/Gate reference/ref.png', 'Boards/Gate reference/ref 2.png', 'Boards/Gate reference/ref 3.png'])
    // The folder, then the batch: a handful of rebuilds, not one per picture.
    expect(app.s().revision - before).toBeLessThanOrEqual(3)
    const again = await app.s().importBoardPictures('Boards/Gate reference.md', [file('ref.png')])
    expect(again).toEqual(['Boards/Gate reference/ref 4.png'])
  })

  it('goes next to the note in a vault of several drives', async () => {
    const app = await freshApp()
    await app.open(new TwoRoots([{ path: 'D/Boards/Gate.md', content: boardRaw('Gate') }]))
    expect(await app.s().importBoardPictures('D/Boards/Gate.md', [file('a.png')])).toEqual(['D/Boards/Gate/a.png'])
  })

  it('moves to “<folder> pictures” when the vault leaves the board’s folder out, once, and stays there', async () => {
    class Excluding extends MemoryVaultAdapter {
      override async createAsset(path: string, data: Uint8Array): Promise<void> {
        if (path.startsWith('Boards/Gate reference/')) throw new Error(`${path} is excluded from the vault`)
        return super.createAsset(path, data)
      }
    }
    const app = await freshApp()
    const v = new Excluding(vaultFiles(), { assets: assetFiles() })
    await app.open(v)
    const paths = await app.s().importBoardPictures('Boards/Gate reference.md', [file('a.png'), file('b.png')])
    expect(paths).toEqual(['Boards/Gate reference pictures/a.png', 'Boards/Gate reference pictures/b.png'])
    expect(toastTexts(app)).toEqual([])
    const spy = vi.spyOn(v, 'createAsset')
    expect(await app.s().importBoardPictures('Boards/Gate reference.md', [file('c.png')])).toEqual(['Boards/Gate reference pictures/c.png'])
    // The second batch did not try the folder the vault refuses.
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['Boards/Gate reference pictures/c.png'])
  })

  it('says why a picture could not be written (the view only learns it was not added)', async () => {
    class Full extends MemoryVaultAdapter {
      override async createAsset(): Promise<void> {
        throw new Error('ENOSPC: no space left on device')
      }
    }
    const app = await freshApp()
    await app.open(new Full(vaultFiles(), { assets: assetFiles() }))
    expect(await app.s().importBoardPictures('Boards/Gate reference.md', [file('a.png')])).toEqual([null])
    expect(toastTexts(app)).toEqual(['Could not add 1 picture to the board: ENOSPC: no space left on device'])
  })

  it('says nothing was saved in a vault that cannot save pictures', async () => {
    const app = await freshApp()
    await app.open(new MemoryVaultAdapter(vaultFiles(), { readOnly: true }))
    expect(await app.s().importBoardPictures('Boards/Gate reference.md', [file('a.png'), file('b.png')])).toEqual([null, null])
    expect(toastTexts(app)).toEqual(['This vault is read-only'])
  })
})

describe('picture helpers that need the desktop adapter', () => {
  it('opens and reveals through the store', async () => {
    const app = await freshApp()
    const v = new DesktopLikeVault(vaultFiles(), { assets: assetFiles() })
    await app.open(v)
    await app.s().openImage('Art/gate.png')
    await app.s().reveal('Art/gate.png')
    expect(v.opened).toEqual(['Art/gate.png'])
    expect(v.revealed).toEqual(['Art/gate.png'])
  })
})
