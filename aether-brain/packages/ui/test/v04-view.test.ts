import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, TODAY_ID, folderKey, ghostKey, imageKey, nextDay, todayIso, type BriefTask, type VaultFile } from '@aether/core'

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

/** Fresh store, key handler and commands modules (fresh settings, extension keys and state). */
async function fresh() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const { handleKey, registerKey } = await import('../src/hooks/useKeyboard')
  const { findCommands } = await import('../src/commands')
  const s = () => useAether.getState()
  const run = (id: string) => {
    const cmd = findCommands('', s()).find((c) => c.id === id)
    if (!cmd) throw new Error(`no command ${id}`)
    return cmd.run(s())
  }
  const ids = () => findCommands('', s()).map((c) => c.id)
  return { useAether, s, handleKey, registerKey, run, ids }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A keydown as the global handler sees it; `target` fakes the focused element. */
function keyEvent(key: string, opts: { shift?: boolean; target?: { tagName: string; role?: string } } = {}) {
  const target = opts.target ?? { tagName: 'BODY' }
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: !!opts.shift,
    defaultPrevented: false,
    target: {
      tagName: target.tagName,
      isContentEditable: false,
      getAttribute: (n: string) => (n === 'role' ? (target.role ?? null) : null),
      hasAttribute: () => false,
    },
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {},
  }
}

const TODAY = todayIso()
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const MB = 1024 * 1024

function vaultFiles(): VaultFile[] {
  return [
    {
      path: 'Projects/Gate.md',
      content: `---\ntitle: Gate\ntype: project\nstatus: active\n---\n# Gate\n\n![[ring.png]]\n\n## To do\n\n- [ ] Ink the gate 📅 ${TODAY}\n- [ ] Later 📅 ${nextDay(TODAY)}\n`,
    },
    { path: 'Inbox/Errands.md', content: '# Errands\n\n- [ ] Buy paper #today\n' },
    { path: 'Resources/Quiet.md', content: '# Quiet\n' },
  ]
}

const pictures = () => [
  { path: 'Projects/Gate/Art/ring.png', data: PNG, mtime: 2000 },
  { path: 'Projects/Gate/Art/sky.png', data: PNG, mtime: 1000 },
]

/** A vault that can show files in the OS file manager (the desktop adapter's `reveal`). */
class RevealingVault extends MemoryVaultAdapter {
  revealed: string[] = []
  async reveal(path: string): Promise<void> {
    this.revealed.push(path)
  }
}

/** Fake `document` with the brief's focusable buttons (focusBrief looks them up). */
function fakeBrief(count: number) {
  const buttons = Array.from({ length: count }, () => ({ focus: vi.fn() }))
  const queries: string[] = []
  vi.stubGlobal('document', {
    querySelectorAll: (sel: string) => {
      queries.push(sel)
      return buttons
    },
  })
  return { buttons, queries }
}

/** A File as the drop / picker hands it over: only `name`, `size` and `arrayBuffer` are used. */
function fakeFile(name: string, size: number, bytes: Uint8Array = PNG) {
  return { name, size, arrayBuffer: vi.fn(async () => bytes.slice().buffer) } as unknown as File & { arrayBuffer: ReturnType<typeof vi.fn> }
}

describe('keys for the Today hub', () => {
  it('y and 7 select the hub and fly there, from the board too; not while typing or over the palette', async () => {
    const { s, handleKey } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    handleKey(keyEvent('y', { target: { tagName: 'INPUT' } }) as unknown as KeyboardEvent)
    expect(s().selectedId).toBeNull()
    s().setPalette(true)
    handleKey(keyEvent('y') as unknown as KeyboardEvent)
    expect(s().selectedId).toBeNull()
    s().setPalette(false)

    handleKey(keyEvent('y') as unknown as KeyboardEvent)
    expect(s().selectedId).toBe(TODAY_ID)
    s().select(null)
    s().setView('projects')
    handleKey(keyEvent('7') as unknown as KeyboardEvent)
    expect(s().selectedId).toBe(TODAY_ID)
    expect(s().view).toBe('graph')
    expect(s().graph!.index.has(TODAY_ID)).toBe(true)
  })

  it('turns the hub back on when it was off', async () => {
    const { s, handleKey } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    s().setSettings({ todayHub: false })
    expect(s().graph!.index.has(TODAY_ID)).toBe(false)
    handleKey(keyEvent('y') as unknown as KeyboardEvent)
    expect(s().settings.todayHub).toBe(true)
    expect(s().selectedId).toBe(TODAY_ID)
  })

  it('Tab walks into the brief (Shift+Tab: from the end) instead of the beams, and falls back to the beams without one', async () => {
    const { s, handleKey } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    s().showToday()
    const { buttons, queries } = fakeBrief(3)
    const tab = keyEvent('Tab')
    handleKey(tab as unknown as KeyboardEvent)
    expect(tab.defaultPrevented).toBe(true)
    expect(buttons[0]!.focus).toHaveBeenCalledOnce()
    expect(queries[0]).toContain('[data-brief]')
    expect(s().hoveredId).toBeNull()
    handleKey(keyEvent('Tab', { shift: true }) as unknown as KeyboardEvent)
    expect(buttons[2]!.focus).toHaveBeenCalledOnce()

    // No brief on screen (All clear, or no DOM): Tab walks the notes of the beams as before.
    fakeBrief(0)
    handleKey(keyEvent('Tab') as unknown as KeyboardEvent)
    expect(['Projects/Gate', 'Inbox/Errands']).toContain(s().hoveredId)
  })

  it('e and Enter on the hub focus its first task, and never open an editor', async () => {
    const { s, handleKey } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    s().showToday()
    const { buttons } = fakeBrief(2)
    handleKey(keyEvent('e') as unknown as KeyboardEvent)
    handleKey(keyEvent('Enter') as unknown as KeyboardEvent)
    expect(buttons[0]!.focus).toHaveBeenCalledTimes(2)
    // Enter on a focused tick box is that button's own (it ticks the task).
    handleKey(keyEvent('Enter', { target: { tagName: 'BUTTON' } }) as unknown as KeyboardEvent)
    expect(buttons[0]!.focus).toHaveBeenCalledTimes(2)
    expect(s().editorId).toBeNull()
    expect(s().selectedId).toBe(TODAY_ID)
  })

  it('u runs the newest toast action (Undo a tick), once', async () => {
    const { s, handleKey } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    const undo = vi.fn()
    s().toast('Ticked “Ink the gate”', 'success', { label: 'Undo', run: undo })
    s().toast('Plain news')
    const u = keyEvent('u')
    handleKey(u as unknown as KeyboardEvent)
    expect(undo).toHaveBeenCalledOnce()
    expect(u.defaultPrevented).toBe(true)
    handleKey(keyEvent('u') as unknown as KeyboardEvent)
    expect(undo).toHaveBeenCalledOnce()
  })

  it('keeps the built-in keys ahead of extension keys, and leaves the desktop’s v, a and g to them', async () => {
    const { s, handleKey, registerKey } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    const stolen = vi.fn()
    registerKey('y', stolen)
    registerKey('7', stolen)
    const panels = { v: vi.fn(), a: vi.fn(), g: vi.fn() }
    for (const [k, fn] of Object.entries(panels)) registerKey(k, fn)
    handleKey(keyEvent('y') as unknown as KeyboardEvent)
    handleKey(keyEvent('7') as unknown as KeyboardEvent)
    expect(stolen).not.toHaveBeenCalled()
    for (const [k, fn] of Object.entries(panels)) {
      handleKey(keyEvent(k) as unknown as KeyboardEvent)
      expect(fn).toHaveBeenCalledOnce()
    }
  })
})

describe('keys and commands for pictures', () => {
  it('e and Enter open the selected picture in the image app; a focused button keeps its Enter', async () => {
    const { s, handleKey, useAether } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { assets: pictures() }))
    const openImage = vi.fn(async () => {})
    const openNote = vi.fn()
    useAether.setState({ openImage, openNote })
    const ring = imageKey('Projects/Gate/Art/ring.png')
    expect(s().graph!.index.has(ring)).toBe(true)
    s().select(ring)
    handleKey(keyEvent('e') as unknown as KeyboardEvent)
    handleKey(keyEvent('Enter') as unknown as KeyboardEvent)
    handleKey(keyEvent('Enter', { target: { tagName: 'BUTTON' } }) as unknown as KeyboardEvent)
    expect(openImage).toHaveBeenCalledTimes(2)
    expect(openImage).toHaveBeenCalledWith('Projects/Gate/Art/ring.png')
    expect(openNote).not.toHaveBeenCalled()
    // `2` (the editor) has nothing to open for a picture.
    handleKey(keyEvent('2') as unknown as KeyboardEvent)
    expect(s().editorId).toBeNull()
  })

  it('offers picture commands only with a picture selected, and reveals the picture itself', async () => {
    const { s, run, ids, useAether } = await fresh()
    const vault = new RevealingVault(vaultFiles(), { assets: pictures() })
    await s().openVault(vault)
    s().select('Projects/Gate')
    expect(ids()).not.toContain('picture-open')
    expect(ids()).not.toContain('picture-embed')
    const ring = imageKey('Projects/Gate/Art/ring.png')
    s().select(ring)
    expect(ids()).toEqual(expect.arrayContaining(['picture-open', 'picture-embed', 'reveal']))
    // Note commands never target a picture.
    for (const id of ['open-selected', 'move-archive', 'status-evergreen', 'delete']) expect(ids()).not.toContain(id)

    const openImage = vi.fn(async () => {})
    useAether.setState({ openImage })
    await run('picture-open')
    expect(openImage).toHaveBeenCalledWith('Projects/Gate/Art/ring.png')
    await run('reveal')
    await vi.waitFor(() => expect(vault.revealed).toEqual(['Projects/Gate/Art/ring.png']))
  })

  it('copies the embed by file name, by path when two pictures share the name, via the desktop bridge when the clipboard is denied', async () => {
    const { s, run } = await fresh()
    const writeText = vi.fn(async (_t: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { assets: [...pictures(), { path: 'Resources/Refs/Sky.PNG', data: PNG }] }))
    s().select(imageKey('Projects/Gate/Art/ring.png'))
    await run('picture-embed')
    expect(writeText).toHaveBeenLastCalledWith('![[ring.png]]')
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'success', text: expect.stringContaining('![[ring.png]]') })

    // `sky.png` and `Sky.PNG` are the same name on Windows and macOS: the path keeps the embed exact.
    s().select(imageKey('Projects/Gate/Art/sky.png'))
    if (!s().graph!.index.has(imageKey('Projects/Gate/Art/sky.png'))) s().setSettings({ layoutMode: 'system' })
    await run('picture-embed')
    expect(writeText).toHaveBeenLastCalledWith('![[Projects/Gate/Art/sky.png]]')

    const copyText = vi.fn(async (_t: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } })
    vi.stubGlobal('aether', { copyText })
    s().select(imageKey('Projects/Gate/Art/ring.png'))
    await run('picture-embed')
    expect(copyText).toHaveBeenCalledWith('![[ring.png]]')

    // Neither works: an error toast, not a silent failure.
    vi.stubGlobal('aether', undefined)
    await run('picture-embed')
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('Could not copy') })
  })

  it('toggles image moons, thumbnails and the Today hub from the palette, saying what changed', async () => {
    const { s, run } = await fresh()
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { assets: pictures() }))
    s().setSettings({ layoutMode: 'system' })
    const sky = imageKey('Projects/Gate/Art/sky.png')
    expect(s().graph!.index.has(sky)).toBe(true)
    await run('picture-moons')
    expect(s().settings.imageMoons).toBe(false)
    expect(s().graph!.index.has(sky)).toBe(false)
    // The embedded picture stays.
    expect(s().graph!.index.has(imageKey('Projects/Gate/Art/ring.png'))).toBe(true)
    expect(s().toasts.at(-1)?.text).toMatch(/moons off/)
    await run('picture-moons')
    expect(s().settings.imageMoons).toBe(true)

    await run('picture-thumbnails')
    expect(s().settings.thumbnails).toBe(false)
    expect(s().controller.showThumbnails).toBe(false)
    await run('picture-thumbnails')
    expect(s().controller.showThumbnails).toBe(true)

    await run('today-hub')
    expect(s().settings.todayHub).toBe(false)
    expect(s().graph!.index.has(TODAY_ID)).toBe(false)
    await run('today')
    expect(s().settings.todayHub).toBe(true)
    expect(s().selectedId).toBe(TODAY_ID)
  })

  it('Import pictures… opens a file picker; the files picked go to the selected folder, others never read', async () => {
    const { s, run, ids, useAether } = await fresh()
    const inputs: { type: string; multiple: boolean; accept: string; files: File[] | null; change?: () => void; click: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('input')
        const input = {
          type: '',
          multiple: false,
          accept: '',
          files: null as File[] | null,
          change: undefined as (() => void) | undefined,
          addEventListener(type: string, cb: () => void) {
            if (type === 'change') this.change = cb
          },
          click: vi.fn(),
        }
        inputs.push(input)
        return input
      },
    })
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { folders: ['Resources/Refs'] }))
    const importImages = vi.fn(async (files: { name: string; data: Uint8Array }[], folder?: string) => files.map((f) => `${folder}/${f.name}`))
    useAether.setState({ importImages })
    s().select(folderKey('Resources/Refs'))
    await run('import-pictures')
    const input = inputs[0]!
    expect(input.type).toBe('file')
    expect(input.multiple).toBe(true)
    expect(input.accept).toContain('.png')
    expect(input.accept).not.toContain('svg')
    expect(input.click).toHaveBeenCalledOnce()

    const ok = fakeFile('gate.png', PNG.byteLength)
    const pdf = fakeFile('notes.pdf', 10)
    const huge = fakeFile('huge.png', 41 * MB)
    input.files = [ok, pdf, huge]
    input.change!()
    await vi.waitFor(() => expect(importImages).toHaveBeenCalledOnce())
    expect(importImages).toHaveBeenCalledWith([{ name: 'gate.png', data: PNG }], 'Resources/Refs')
    expect(pdf.arrayBuffer).not.toHaveBeenCalled()
    expect(huge.arrayBuffer).not.toHaveBeenCalled()
    const texts = s().toasts.map((t) => t.text)
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining('notes.pdf is not a picture'), expect.stringContaining('huge.png over 40 MB')]))

    // Not offered where nothing can be written.
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { readOnly: true }))
    expect(ids()).not.toContain('import-pictures')
    await s().openVault(Object.assign(new MemoryVaultAdapter(vaultFiles()), { createAsset: undefined }))
    expect(ids()).not.toContain('import-pictures')
  })
})

describe('importPictureFiles', () => {
  it('saves into the selected folder with the real store, and reads a big drop in chunks into one target', async () => {
    const { s, useAether } = await fresh()
    const { importPictureFiles } = await import('../src/components/pictures')
    const vault = new MemoryVaultAdapter(vaultFiles(), { folders: ['Resources/Refs'] })
    await s().openVault(vault)
    s().select(folderKey('Resources/Refs'))
    const written = await importPictureFiles([fakeFile('gate.png', PNG.byteLength)])
    expect(written).toEqual(['Resources/Refs/gate.png'])
    expect(vault.assetData('Resources/Refs/gate.png')).toEqual(PNG)
    // The import selects the new picture: a second drop now goes elsewhere (the selection is no folder).
    expect(s().selectedId).toBe(imageKey('Resources/Refs/gate.png'))

    // Eight 39 MB pictures: two calls, both into the folder chosen before the first one landed.
    s().select(folderKey('Resources/Refs'))
    const calls: { count: number; folder: string | undefined }[] = []
    useAether.setState({
      importImages: async (files, folder) => {
        calls.push({ count: files.length, folder })
        useAether.getState().select('Inbox/Errands')
        return files.map((f) => `${folder}/${f.name}`)
      },
    })
    const big = Array.from({ length: 8 }, (_, i) => fakeFile(`big-${i}.png`, 39 * MB, Uint8Array.of(i)))
    const paths = await importPictureFiles(big)
    expect(calls).toEqual([
      { count: 6, folder: 'Resources/Refs' },
      { count: 2, folder: 'Resources/Refs' },
    ])
    expect(paths).toHaveLength(8)
  })

  it('reports a file that can’t be read and still imports the rest; nothing at all without a vault', async () => {
    const { s, useAether } = await fresh()
    const { importPictureFiles } = await import('../src/components/pictures')
    const importImages = vi.fn(async (files: { name: string }[]) => files.map((f) => f.name))
    expect(await importPictureFiles([fakeFile('a.png', 3)])).toEqual([])
    await s().openVault(new MemoryVaultAdapter(vaultFiles()))
    useAether.setState({ importImages })
    const gone = fakeFile('gone.png', 3)
    gone.arrayBuffer.mockRejectedValueOnce(new Error('NotFoundError'))
    await importPictureFiles([gone, fakeFile('b.png', 3)])
    expect(importImages).toHaveBeenCalledOnce()
    expect(importImages.mock.calls[0]![0]).toEqual([{ name: 'b.png', data: PNG }])
    expect(s().toasts.some((t) => t.kind === 'error' && t.text.includes('gone.png'))).toBe(true)

    // The store failing outright is said, not an unhandled rejection.
    useAether.setState({ importImages: async () => Promise.reject(new Error('disk full')) })
    expect(await importPictureFiles([fakeFile('c.png', 3)])).toEqual([])
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('disk full') })
  })
})

describe('inspector rows', () => {
  it('shows pictures, the hub and folders in link lists by what they are', async () => {
    await fresh()
    const { linkRow } = await import('../src/components/Inspector')
    expect(linkRow(imageKey('Projects/Gate/Art/ring.png'), undefined)).toMatchObject({ kind: 'image', label: '🖼 ring.png' })
    expect(linkRow(TODAY_ID, undefined)).toMatchObject({ kind: 'today', label: '☀ Today' })
    expect(linkRow(ghostKey('Missing'), undefined)).toMatchObject({ kind: 'ghost', label: '+ Missing' })
    expect(linkRow(folderKey('Projects/Gate/Art'), undefined)).toMatchObject({ kind: 'folder', label: '● Art' })
    expect(linkRow('Projects/Gate', { title: 'Gate', area: 'projects' })).toMatchObject({ kind: 'note', label: 'Gate', dotClass: 'bg-projects' })
  })

  it('says why a task is on the brief and when it is due', async () => {
    await fresh()
    const { briefChip } = await import('../src/components/Inspector')
    const day = '2026-09-30'
    const task = (patch: Partial<BriefTask>): BriefTask => ({
      noteId: 'Projects/Gate',
      notePath: 'Projects/Gate.md',
      noteTitle: 'Gate',
      line: 9,
      text: 'Ink the gate',
      label: 'Ink the gate',
      due: null,
      scheduled: null,
      reason: 'next',
      projectId: 'Projects/Gate',
      projectTitle: 'Gate',
      section: 'To do',
      ...patch,
    })
    expect(briefChip(task({ reason: 'overdue', due: '2026-09-27' }), day)).toMatchObject({ text: '📅 3 days late', tone: 'late' })
    expect(briefChip(task({ reason: 'overdue', due: '2026-09-29' }), day)?.text).toBe('📅 yesterday')
    expect(briefChip(task({ reason: 'due', due: day }), day)).toMatchObject({ text: '📅 due today', tone: 'today' })
    expect(briefChip(task({ reason: 'scheduled', scheduled: day }), day)?.text).toBe('⏳ today')
    expect(briefChip(task({ reason: 'scheduled', scheduled: '2026-09-29' }), day)?.text).toBe('⏳ since yesterday')
    expect(briefChip(task({ reason: 'daily' }), day)?.text).toBe('daily note')
    expect(briefChip(task({ reason: 'flagged' }), day)?.text).toBe('#today')
    expect(briefChip(task({ reason: 'next' }), day)).toBeNull()
    expect(briefChip(task({ reason: 'next', due: '2026-10-01' }), day)).toMatchObject({ text: '📅 tomorrow', tone: 'plain' })
  })

  it('formats file sizes for people', async () => {
    const { formatBytes } = await import('../src/components/pictures')
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(4300)).toBe('4.2 KB')
    expect(formatBytes(31 * 1024)).toBe('31 KB')
    expect(formatBytes(2.4 * MB)).toBe('2.4 MB')
  })
})

describe('rendering (server markup, no DOM)', () => {
  /**
   * A component as markup, rendered from the store's live state. Server
   * rendering reads the store's initial state object, so the live state is
   * copied onto it first (each test has a fresh store).
   */
  async function renderer() {
    const env = await fresh()
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const html = async (file: string, name: string, props: Record<string, unknown> = {}) => {
      const mod = (await import(`../src/components/${file}.tsx`)) as Record<string, (p: Record<string, unknown>) => React.ReactNode>
      Object.assign(env.useAether.getInitialState(), env.useAether.getState())
      return renderToStaticMarkup(createElement(mod[name]!, props))
    }
    return { ...env, html }
  }

  it('shows the brief with its sections, rows and chips, and the empty state', async () => {
    const { s, html } = await renderer()
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { assets: pictures() }))
    s().select(TODAY_ID)
    const out = await html('Inspector', 'Inspector')
    expect(out).toContain('Today · daily brief')
    expect(out).toMatch(/Today · 2/)
    expect(out).toContain('Ink the gate')
    expect(out).toContain('📅 due today')
    expect(out).toContain('#today')
    expect(out).toContain('role="checkbox"')
    expect(out).toContain('★</span>Gate')
    expect(out).not.toContain('📅 ' + TODAY)

    await s().openVault(new MemoryVaultAdapter([{ path: 'Resources/Quiet.md', content: '# Quiet\n' }]))
    s().select(TODAY_ID)
    expect(await html('Inspector', 'Inspector')).toContain('All clear for today')
  })

  it('shows a picture, a folder’s pictures, and pictures in link lists', async () => {
    const { s, html } = await renderer()
    await s().openVault(new MemoryVaultAdapter(vaultFiles(), { assets: pictures() }))
    s().setSettings({ layoutMode: 'system' })
    s().select(imageKey('Projects/Gate/Art/ring.png'))
    let out = await html('Inspector', 'Inspector')
    expect(out).toContain('ring.png')
    expect(out).toContain('Projects/Gate/Art/')
    expect(out).toContain('Copy embed')
    expect(out).toContain('Embedded in · 1')
    expect(out).toContain('Loading preview…')

    s().select(folderKey('Projects/Gate/Art'))
    out = await html('Inspector', 'Inspector')
    expect(out).toContain('🖼 2 pictures · 2 shown')
    expect(out).toContain('Import pictures…')
    expect(out).toContain('Pictures · 2')

    s().select('Projects/Gate')
    expect(await html('Inspector', 'Inspector')).toContain('🖼 ring.png')

    const bar = await html('TopBar', 'TopBar')
    expect(bar).toContain('Today')
    expect(bar).toContain('🖼')
    const legend = await html('Legend', 'Legend')
    expect(legend).toContain('picture · ')
    expect(legend).toContain('Today · 2')
    s().setHelp(true)
    expect(await html('Help', 'Help')).toContain('Today &amp; pictures')
  })
})
