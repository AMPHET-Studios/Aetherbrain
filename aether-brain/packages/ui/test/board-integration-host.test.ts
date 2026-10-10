import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, imageKey, parseBoard, type VaultFile } from '@aether/core'
import type { BoardWindowControl, BoardWindowStatus } from '../src/board/active'
import { DesktopLikeVault, PNG, assetFiles, boardRaw, freshApp, tick, vaultFiles } from './board-integration-harness'

// The first test loads the whole UI package, which takes seconds on a busy machine (the default 5 s timed out at 5.1 s and 8.1 s).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const withVideo = () => [...assetFiles(), { path: 'Art/turntable.mp4', data: PNG, mtime: 500 }]
const vault = (files: VaultFile[] = vaultFiles()) => new MemoryVaultAdapter(files, { assets: withVideo() })

/** A host over the Armour board, loaded, and a counter of the outside changes it reports. */
async function hosted(v: MemoryVaultAdapter = vault()) {
  const app = await freshApp()
  await app.open(v)
  const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
  const outside = vi.fn()
  const off = host.onExternalChange!(outside)
  const raw = await host.load()
  return { app, v, host, outside, off, raw }
}

/** The floating window's control as the desktop app registers it, with the calls made on it and a way to change its state. */
function fakeControl(initial: Partial<BoardWindowStatus> = {}) {
  let status: BoardWindowStatus = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: true, ...initial }
  const subs = new Set<() => void>()
  const calls: string[] = []
  const control: BoardWindowControl = {
    available: true,
    status: () => status,
    subscribe: (cb) => (subs.add(cb), () => void subs.delete(cb)),
    popOut: async (p) => (calls.push(`popOut ${p}`), true),
    dock: async () => void calls.push('dock'),
    setAlwaysOnTop: async (on) => void calls.push(`onTop ${on}`),
    setOpacity: async (o) => void calls.push(`opacity ${o}`),
    onReturned: () => () => undefined,
    setFlush: () => () => undefined,
  }
  return {
    control,
    calls,
    subs,
    change(next: Partial<BoardWindowStatus>) {
      status = { ...status, ...next }
      for (const cb of [...subs]) cb()
    },
  }
}

describe('the note', () => {
  it('names its path and title, the title from the note and then from the board', async () => {
    const app = await freshApp()
    await app.open(vault())
    const host = app.hostModule.createDockedBoardHost('Boards/Gate reference.md')
    expect(host.path).toBe('Boards/Gate reference.md')
    expect(host.title).toBe('Gate reference')
    await app.s().patchFrontmatter('Boards/Gate reference', { title: 'Gate, final' })
    await host.load()
    expect(host.title).toBe('Gate, final')
  })

  it('loads the note as it is on disk now', async () => {
    const { v, host, raw } = await hosted()
    expect(raw).toBe(boardRaw('Armour'))
    expect(await v.read('Boards/Armour.md')).toBe(raw)
    expect(await host.load()).toBe(raw)
  })

  it('does not load what is not a board, or is gone, and says so', async () => {
    const app = await freshApp()
    await app.open(vault())
    await expect(app.hostModule.createDockedBoardHost('Inbox/Idea.md').load()).rejects.toThrow(/not a board/)
    await expect(app.hostModule.createDockedBoardHost('Boards/Nope.md').load()).rejects.toThrow(/not a board, is gone/)
  })

  it('saves the whole text it is given, and the store has it at once', async () => {
    const { app, v, host } = await hosted()
    const next = boardRaw('Armour', ['Art/sky.png'], '2026-10-09')
    await host.save(next)
    expect(await v.read('Boards/Armour.md')).toBe(next)
    expect(app.s().notes.get('Boards/Armour')!.raw).toBe(next)
    expect(app.s().graph!.outlinks.get('Boards/Armour')?.has(imageKey('Art/sky.png'))).toBe(true)
  })

  it('saves one after the other, each starting from the one before', async () => {
    const { v, host } = await hosted()
    const a = boardRaw('Armour', ['Art/sky.png'], '2026-10-06')
    const b = boardRaw('Armour', ['Art/sky.png', 'Art/gate.png'], '2026-10-07')
    const c = boardRaw('Armour', ['Art/gate.png'], '2026-10-08')
    await Promise.all([host.save(a), host.save(b), host.save(c)])
    expect(await v.read('Boards/Armour.md')).toBe(c)
  })

  it('a save that fails does not stop the next one', async () => {
    const { v, host } = await hosted()
    const write = vi.spyOn(v, 'write').mockRejectedValueOnce(new Error('disk full'))
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']))).rejects.toThrow('disk full')
    const ok = boardRaw('Armour', ['Art/gate.png'], '2026-10-09')
    await host.save(ok)
    expect(write).toHaveBeenCalledTimes(2)
    expect(await v.read('Boards/Armour.md')).toBe(ok)
  })

  it('refuses text that is not a board', async () => {
    const { v, host, raw } = await hosted()
    await expect(host.save('# not a board\n')).rejects.toThrow(/not a board/)
    expect(await v.read('Boards/Armour.md')).toBe(raw)
  })
})

describe('a note changed by somebody else', () => {
  it('refuses to save over it, writes nothing, and tells the view', async () => {
    const { app, v, host, outside, raw } = await hosted()
    await v.write('Boards/Armour.md', raw + '\nTyped in an editor.\n')
    outside.mockClear()
    const write = vi.spyOn(v, 'write')
    const err = await host.save(boardRaw('Armour', ['Art/sky.png'])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(app.hostModule.BoardChangedOutsideError)
    expect((err as Error).message).toMatch(/changed outside/)
    expect(write).not.toHaveBeenCalled()
    expect(await v.read('Boards/Armour.md')).toContain('Typed in an editor.')
    expect(outside).toHaveBeenCalled()
  })

  it('keeps refusing until the note is read again, however often the view tries', async () => {
    const { v, host, raw } = await hosted()
    await v.write('Boards/Armour.md', raw + '\nElsewhere.\n')
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']))).rejects.toThrow(/changed outside/)
    // The outside edit is undone: the host still does not trust what it holds.
    await v.write('Boards/Armour.md', raw)
    await expect(host.save(boardRaw('Armour', ['Art/sky.png']))).rejects.toThrow(/changed outside/)
    const fresh = await host.load()
    expect(fresh).toBe(raw)
    await host.save(boardRaw('Armour', ['Art/sky.png'], '2026-10-09'))
    expect(parseBoard((await v.read('Boards/Armour.md'))!).doc.items).toHaveLength(1)
  })

  it('reports an outside edit once, and a view that reloads then saves normally', async () => {
    const { host, v, outside, raw } = await hosted()
    outside.mockClear()
    const theirs = raw + '\nAn AI added a line.\n'
    await v.write('Boards/Armour.md', theirs)
    expect(outside).toHaveBeenCalledTimes(1)
    expect(await host.load()).toBe(theirs)
    // The reload reads what the store already has: nothing more is reported.
    expect(outside).toHaveBeenCalledTimes(1)
    await host.save(theirs + 'x')
  })

  it('is told when the note is deleted', async () => {
    const { v, outside } = await hosted()
    outside.mockClear()
    await v.remove('Boards/Armour.md')
    expect(outside).toHaveBeenCalledTimes(1)
  })

  it('hears of a change made between its load and its listening', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
    const raw = await host.load()
    await v.write('Boards/Armour.md', raw + '\nWhile nobody listened.\n')
    const late = vi.fn()
    host.onExternalChange!(late)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('does not listen before it has loaded: there is nothing to differ from', async () => {
    const app = await freshApp()
    const v = await app.open(vault())
    const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
    const cb = vi.fn()
    host.onExternalChange!(cb)
    await v.write('Boards/Armour.md', boardRaw('Armour', ['Art/sky.png']))
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('its own saves are not outside changes', () => {
  it('does not report a save, nor the store applying it, nor a second save', async () => {
    const { host, outside } = await hosted()
    outside.mockClear()
    await host.save(boardRaw('Armour', ['Art/sky.png'], '2026-10-06'))
    await host.save(boardRaw('Armour', ['Art/gate.png'], '2026-10-07'))
    await tick()
    expect(outside).not.toHaveBeenCalled()
  })

  it('does not report the watcher’s late echo of an older save of its own', async () => {
    const { host, v, outside } = await hosted()
    const a = boardRaw('Armour', ['Art/sky.png'], '2026-10-06')
    const b = boardRaw('Armour', ['Art/gate.png'], '2026-10-07')
    await host.save(a)
    await host.save(b)
    outside.mockClear()
    // A slow disk reports the first save after the second has been written.
    v.external([{ kind: 'change', path: 'Boards/Armour.md', content: a }])
    v.external([{ kind: 'change', path: 'Boards/Armour.md', content: b }])
    expect(outside).not.toHaveBeenCalled()
  })

  it('remembers only the last few: an old text coming back is somebody else’s', async () => {
    const { host, v, outside, app } = await hosted()
    const texts = Array.from({ length: app.hostModule.ECHO_TEXTS + 2 }, (_, i) => boardRaw('Armour', ['Art/sky.png'], `2026-10-${String(10 + i).padStart(2, '0')}`))
    for (const t of texts) await host.save(t)
    outside.mockClear()
    v.external([{ kind: 'change', path: 'Boards/Armour.md', content: texts[0]! }])
    expect(outside).toHaveBeenCalledTimes(1)
  })

  it('stops reporting when the view stops listening, and a view that mounts again listens afresh', async () => {
    const { host, v, outside, off, raw } = await hosted()
    off()
    outside.mockClear()
    await v.write('Boards/Armour.md', raw + '\nUnheard.\n')
    expect(outside).not.toHaveBeenCalled()
    const again = vi.fn()
    host.onExternalChange!(again)
    // What changed while nobody listened is reported to the one who listens next.
    expect(again).toHaveBeenCalledTimes(1)
    again.mockClear()
    await v.write('Boards/Armour.md', raw + '\nHeard.\n')
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('lets go of the store when disposed', async () => {
    const { host, v, outside, raw } = await hosted()
    host.dispose()
    outside.mockClear()
    await v.write('Boards/Armour.md', raw + '\nAfter dispose.\n')
    expect(outside).not.toHaveBeenCalled()
  })
})

describe('the pictures', () => {
  it('gives previews and whole pictures from the vault, or null', async () => {
    const { host } = await hosted()
    const preview = await host.pictures.preview('Art/gate.png', 256)
    expect(preview?.type).toBe('image/png')
    const whole = await host.pictures.original('Art/gate.png')
    expect(whole?.size).toBe(PNG.length)
    expect(await host.pictures.preview('Art/missing.png', 256)).toBeNull()
    expect(await host.pictures.original('Art/missing.png')).toBeNull()
    // A video is not a picture to read whole.
    expect(await host.pictures.original('Art/turntable.mp4')).toBeNull()
  })

  it('lists the pictures of the vault, and no video', async () => {
    const { host } = await hosted()
    const list = await host.pictures.list()
    expect(list.map((a) => a.path).sort()).toEqual(['Art/gate.png', 'Art/ring.png', 'Art/sky.png'])
    expect(host.pictures.exists('Art/gate.png')).toBe(true)
    expect(host.pictures.exists('Art/gone.png')).toBe(false)
  })

  it('adds pictures into the board’s folder quietly, one answer per file', async () => {
    const { app, host } = await hosted()
    const out = await host.pictures.add([
      { name: 'ref a.png', data: PNG },
      { name: 'readme.txt', data: PNG },
      { name: 'ref b.png', data: PNG },
    ])
    expect(out).toEqual(['Boards/Armour/ref a.png', null, 'Boards/Armour/ref b.png'])
    expect(host.pictures.exists('Boards/Armour/ref a.png')).toBe(true)
    expect(app.s().selectedId).toBeNull()
    expect(app.s().toasts).toEqual([])
  })

  it('opens in the image program, and reveals only where the vault can', async () => {
    const plain = await hosted()
    expect(plain.host.pictures.reveal).toBeUndefined()
    const desk = new DesktopLikeVault(vaultFiles(), { assets: assetFiles() })
    const { host } = await hosted(desk)
    host.pictures.open!('Art/gate.png')
    host.pictures.reveal!('Art/gate.png')
    await tick(5)
    expect(desk.opened).toEqual(['Art/gate.png'])
    expect(desk.revealed).toEqual(['Art/gate.png'])
  })

  it('shows a picture in the brain: the view closes and the picture is selected', async () => {
    const { app, host } = await hosted()
    app.s().openBoard('Boards/Armour.md')
    host.pictures.showInBrain!('Art/ring.png')
    expect(app.s().view).toBe('graph')
    expect(app.s().selectedId).toBe(imageKey('Art/ring.png'))
  })

  it('hears of pictures coming and going, not of notes, and stops when told to', async () => {
    const { v, host } = await hosted()
    const changed = vi.fn()
    const off = host.pictures.onChange!(changed)
    await v.createAsset('Art/new.png', PNG)
    expect(changed).toHaveBeenCalledTimes(1)
    await v.write('Inbox/Idea.md', '# Idea\n\nchanged\n')
    expect(changed).toHaveBeenCalledTimes(1)
    await v.remove('Art/new.png')
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    await v.createAsset('Art/other.png', PNG)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('messages and the clipboard', () => {
  it('shows a toast of the kind asked for, with its button', async () => {
    const { app, host } = await hosted()
    const run = vi.fn()
    host.toast('Saved')
    host.toast('Oops', 'error')
    host.toast('Done', 'success', { label: 'Show', run })
    const toasts = app.s().toasts
    expect(toasts.map((t) => [t.text, t.kind])).toEqual([
      ['Saved', 'info'],
      ['Oops', 'error'],
      ['Done', 'success'],
    ])
    toasts[2]!.action!.run()
    expect(run).toHaveBeenCalled()
  })

  it('copies through the browser clipboard, else through the desktop bridge', async () => {
    const { host } = await hosted()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await host.copyText('#ff8800')
    expect(writeText).toHaveBeenCalledWith('#ff8800')
    // The sandboxed window: the browser's clipboard says no, the bridge does it.
    const copyText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    vi.stubGlobal('aether', { copyText })
    await host.copyText('#00ff88')
    expect(copyText).toHaveBeenCalledWith('#00ff88')
  })
})

describe('the floating window', () => {
  it('is not offered where there is no control (the web)', async () => {
    const { host } = await hosted()
    expect(host.window).toBeUndefined()
  })

  it('is not offered when the control says the platform has none', async () => {
    const app = await freshApp()
    await app.open(vault())
    const f = fakeControl()
    app.active.setBoardWindowControl({ ...f.control, available: false })
    expect(app.hostModule.createDockedBoardHost('Boards/Armour.md').window).toBeUndefined()
  })

  it('shows the window’s state, and pops this board out through the control', async () => {
    const app = await freshApp()
    await app.open(vault())
    const f = fakeControl({ alwaysOnTop: false, opacity: 0.6, supportsOpacity: true })
    app.active.setBoardWindowControl(f.control)
    const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
    const w = host.window!
    expect(w).toMatchObject({ floating: false, alwaysOnTop: false, opacity: 0.6, supportsOpacity: true })
    expect(host.window).toBe(w)
    w.popOut()
    w.dock()
    expect(f.calls).toEqual(['popOut Boards/Armour.md'])
    f.change({ alwaysOnTop: true, opacity: 0.9, supportsOpacity: false })
    expect(w).toMatchObject({ alwaysOnTop: true, opacity: 0.9, supportsOpacity: false })
  })

  it('shows a setting at once, until the desktop app answers', async () => {
    const app = await freshApp()
    await app.open(vault())
    const f = fakeControl({ alwaysOnTop: true, opacity: 1 })
    app.active.setBoardWindowControl(f.control)
    const w = app.hostModule.createDockedBoardHost('Boards/Armour.md').window!
    w.setAlwaysOnTop(false)
    w.setOpacity(0.5)
    expect(w).toMatchObject({ alwaysOnTop: false, opacity: 0.5 })
    expect(f.calls).toEqual(['onTop false', 'opacity 0.5'])
    // main answers with what the window really is.
    f.change({ alwaysOnTop: true, opacity: 0.8 })
    expect(w).toMatchObject({ alwaysOnTop: true, opacity: 0.8 })
  })

  it('keeps opacity between 20% and 100%, and ignores what is not a number', async () => {
    const app = await freshApp()
    await app.open(vault())
    const f = fakeControl()
    app.active.setBoardWindowControl(f.control)
    const w = app.hostModule.createDockedBoardHost('Boards/Armour.md').window!
    w.setOpacity(0)
    w.setOpacity(7)
    w.setOpacity(Number.NaN)
    expect(f.calls).toEqual(['opacity 0.2', 'opacity 1'])
  })

  it('stops following the control when disposed', async () => {
    const app = await freshApp()
    await app.open(vault())
    const f = fakeControl()
    app.active.setBoardWindowControl(f.control)
    const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
    void host.window
    expect(f.subs.size).toBe(1)
    ;(host as { dispose(): void }).dispose()
    expect(f.subs.size).toBe(0)
  })
})
