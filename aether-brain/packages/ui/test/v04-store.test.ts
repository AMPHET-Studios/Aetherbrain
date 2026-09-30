import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryVaultAdapter,
  TODAY_ID,
  critiqueNote,
  dailyBrief,
  folderKey,
  imageKey,
  isImagePath,
  nextDay,
  todayIso,
  type VaultFile,
  type VaultRootInfo,
} from '@aether/core'

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

/** A fresh store module (fresh settings, controller and state). */
async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether, addDays } = await import('../src/store')
  return { s: () => useAether.getState(), addDays }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A memory vault whose changes never reach the app (a watcher that has not reported yet). */
class QuietVault extends MemoryVaultAdapter {
  override watch(): () => void {
    return () => {}
  }
}

/** A vault that opens pictures in "the OS app" (the desktop adapter's `openAsset`). */
class OpeningVault extends MemoryVaultAdapter {
  opened: string[] = []
  fail = false
  async openAsset(path: string): Promise<void> {
    if (this.fail) throw new Error('no app for .png')
    this.opened.push(path)
  }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 255)

const TODAY = todayIso()
const TOMORROW = nextDay(TODAY)

function project(title: string, extra = '', tasks = '- [ ] First step\n'): string {
  return `---\ntitle: ${title}\ntype: project\nstatus: active\n${extra}---\n# ${title}\n\n## To do\n\n${tasks}`
}

describe('the Today hub', () => {
  const vault = (yesterday: string) =>
    new MemoryVaultAdapter([
      { path: 'Projects/Gate.md', content: project('Gate', '', `- [ ] Ink the gate 📅 ${yesterday}\n- [ ] Value pass 📅 ${TODAY}\n- [ ] Later 📅 ${TOMORROW}\n`) },
      { path: 'Inbox/Errands.md', content: '# Errands\n\n- [ ] Buy paper #today\n' },
      { path: 'Resources/Quiet.md', content: '# Quiet\n\nNo tasks here.\n' },
    ])

  it('gathers today’s tasks into a hub with beams, in every layout, and a ticked task leaves it', async () => {
    const { s, addDays } = await freshStore()
    await s().openVault(vault(addDays(TODAY, -1)))
    const b = s().brief!
    expect(b.date).toBe(TODAY)
    expect(b.overdue.map((t) => t.label)).toEqual(['Ink the gate'])
    expect(b.today.map((t) => t.label)).toEqual(['Value pass', 'Buy paper #today'])
    const hub = () => s().graph!.nodes[s().graph!.index.get(TODAY_ID)!]!
    expect(hub().kind).toBe('today')
    expect(hub().today).toMatchObject({ date: TODAY, overdue: 1, today: 2, total: 3 })
    expect(hub().parent).toBe(folderKey(''))
    expect([...s().graph!.outlinks.get(TODAY_ID)!].sort()).toEqual(['Inbox/Errands', 'Projects/Gate'])

    // A brief row ticks its task in its own note; the brief and the hub follow.
    const row = b.today[0]!
    await s().toggleTask(row.noteId, row.line, true)
    expect(s().notes.get('Projects/Gate')!.raw).toMatch(/- \[x\] Value pass 📅 \S+ ✅/)
    expect(s().brief!.today.map((t) => t.label)).toEqual(['Buy paper #today'])
    expect(hub().today).toMatchObject({ today: 1, total: 2 })

    s().toggleLayout()
    expect(s().settings.layoutMode).toBe('constellation')
    expect(hub().parent).toBeNull()
    s().setSettings({ todayHub: false })
    expect(s().graph!.index.has(TODAY_ID)).toBe(false)
    // The brief stays (the top bar shows it) while the hub is off.
    expect(s().brief!.total).toBe(2)
  })

  it('keeps the brief object while nothing on it changes, and refreshes it when the day turns', async () => {
    const { s, addDays } = await freshStore()
    await s().openVault(vault(addDays(TODAY, -1)))
    const brief = s().brief
    await s().writeNote('Inbox/Unrelated.md', '# Unrelated\n')
    expect(s().brief).toBe(brief)

    // Same day: nothing to do (not even a rebuild).
    const graph = s().graph
    s().refreshBrief()
    expect(s().graph).toBe(graph)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${TOMORROW}T09:00:00`))
    s().refreshBrief()
    expect(s().graph).not.toBe(graph)
    expect(s().brief!.date).toBe(TOMORROW)
    expect(s().brief!.today.map((t) => t.label)).toContain('Later')
    expect(s().brief!.overdue.map((t) => t.label)).toEqual(['Ink the gate', 'Value pass'])
    expect(s().graph!.nodes[s().graph!.index.get(TODAY_ID)!]!.today?.date).toBe(TOMORROW)
  })

  it('showToday turns the hub on, steps out of the board and selects it; opening it opens no editor', async () => {
    const { s, addDays } = await freshStore()
    await s().openVault(vault(addDays(TODAY, -1)))
    s().setSettings({ todayHub: false })
    s().setView('projects')
    s().showToday()
    expect(s().settings.todayHub).toBe(true)
    expect(s().graph!.index.has(TODAY_ID)).toBe(true)
    expect(s().selectedId).toBe(TODAY_ID)
    expect(s().view).toBe('graph')

    s().openNote(TODAY_ID, { fly: true })
    expect(s().editorId).toBeNull()
    expect(s().selectedId).toBe(TODAY_ID)

    // Tab walks the notes of its beams.
    s().cycleNeighbor(1)
    expect(['Inbox/Errands', 'Projects/Gate']).toContain(s().hoveredId)

    // The hub going away takes the selection with it.
    s().setSettings({ todayHub: false })
    expect(s().selectedId).toBeNull()
  })

  it('never treats the hub or a picture as a note', async () => {
    const { s, addDays } = await freshStore()
    const v = vault(addDays(TODAY, -1))
    await s().openVault(v)
    const before = await v.list()
    await s().deleteNote(TODAY_ID)
    await s().toggleTask(TODAY_ID, 0, true)
    await s().patchFrontmatter(imageKey('Art/a.png'), { status: 'done' })
    await expect(s().renameNote(TODAY_ID, 'Inbox/x')).rejects.toThrow('No such note')
    await expect(s().moveToArea(imageKey('Art/a.png'), 'archive')).rejects.toThrow('No such note')
    s().selectProject(TODAY_ID)
    expect(s().projectId).toBeNull()
    await s().reviewMark(TODAY_ID, 'keep')
    expect(s().review[TODAY_ID]).toBeUndefined()
    expect(await v.list()).toEqual(before)
  })
})

describe('pictures', () => {
  const notes = (): VaultFile[] => [
    { path: 'Projects/Gate.md', content: project('Gate') },
    { path: 'Projects/Gate/Art/Study.md', content: '# Study\n\n![[ring.png]]\n\nPart of [[Gate]].\n' },
    { path: 'Inbox/Idea.md', content: '# Idea\n' },
  ]
  const pictures = () => [
    { path: 'Projects/Gate/Art/ring.png', data: bytes(10), mtime: 3 },
    { path: 'Projects/Gate/Art/sky.png', data: bytes(20), mtime: 2 },
    { path: 'Projects/Gate/Art/ruin.jpg', data: bytes(30), mtime: 1 },
  ]
  const images = (s: () => { graph: { nodes: { kind: string; id: string }[] } | null }) =>
    s()
      .graph!.nodes.filter((n) => n.kind === 'image')
      .map((n) => n.id)
      .sort()

  it('shows embedded pictures in every layout, and each folder’s newest ones as moons in the system layout', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(notes(), { assets: pictures() }))
    expect(s().assets.size).toBe(3)
    expect(images(s)).toEqual(['Projects/Gate/Art/ring.png', 'Projects/Gate/Art/ruin.jpg', 'Projects/Gate/Art/sky.png'].map(imageKey))
    const art = s().graph!.nodes[s().graph!.index.get(folderKey('Projects/Gate/Art'))!]!
    expect(art.folder).toMatchObject({ images: 3, shownImages: 3 })
    expect(s().graph!.outlinks.get('Projects/Gate/Art/Study')?.has(imageKey('Projects/Gate/Art/ring.png'))).toBe(true)

    s().setSettings({ imageMoons: false })
    expect(images(s)).toEqual([imageKey('Projects/Gate/Art/ring.png')])
    s().setSettings({ imageMoons: true })
    s().toggleLayout()
    expect(s().settings.layoutMode).toBe('constellation')
    expect(images(s)).toEqual([imageKey('Projects/Gate/Art/ring.png')])
  })

  it('hands the adapter’s thumbnails to the brain, and follows the thumbnails setting', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(notes(), { assets: pictures() }))
    const load = s().controller.thumbnails
    expect(load).toBeTypeOf('function')
    const blob = await load!('Projects/Gate/Art/sky.png', 128)
    expect(blob?.size).toBe(20)
    expect(s().controller.showThumbnails).toBe(true)
    s().setSettings({ thumbnails: false })
    expect(s().controller.showThumbnails).toBe(false)

    // A vault without previews: plain moons.
    const plain = Object.assign(new MemoryVaultAdapter(notes()), { thumbnail: undefined })
    await s().openVault(plain)
    expect(s().controller.thumbnails).toBeNull()
  })

  it('follows picture changes from the adapter, keeping the picture map while no picture changes', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(notes(), { assets: pictures() })
    await s().openVault(vault)
    const assets = s().assets
    await s().writeNote('Inbox/Other.md', '# Other\n')
    expect(s().assets).toBe(assets)

    vault.external([{ kind: 'add', path: 'Projects/Gate/Art/new.png', mtime: 10, size: 5 }])
    expect(s().assets).not.toBe(assets)
    expect(s().assets.get('Projects/Gate/Art/new.png')).toEqual({ path: 'Projects/Gate/Art/new.png', mtime: 10, size: 5 })
    expect(s().graph!.index.has(imageKey('Projects/Gate/Art/new.png'))).toBe(true)

    vault.external([{ kind: 'unlink', path: 'Projects/Gate/Art/sky.png' }])
    expect(s().assets.has('Projects/Gate/Art/sky.png')).toBe(false)
    expect(s().graph!.index.has(imageKey('Projects/Gate/Art/sky.png'))).toBe(false)

    vault.external([{ kind: 'unlinkDir', path: 'Projects/Gate/Art' }])
    expect([...s().assets.keys()]).toEqual([])
  })

  it('opens a picture in the OS app (open, e, a double click), or says why it can’t', async () => {
    const { s } = await freshStore()
    const vault = new OpeningVault(notes(), { assets: pictures() })
    await s().openVault(vault)
    const ring = imageKey('Projects/Gate/Art/ring.png')
    s().openNote(ring, { fly: true })
    await vi.waitFor(() => expect(vault.opened).toEqual(['Projects/Gate/Art/ring.png']))
    expect(s().selectedId).toBe(ring)
    expect(s().editorId).toBeNull()
    expect(s().history).toEqual([])

    const { handleKey } = await import('../src/hooks/useKeyboard')
    const key = (k: string) =>
      handleKey({
        key: k,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        target: { tagName: 'BODY', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false },
        preventDefault() {},
        stopPropagation() {},
      } as unknown as KeyboardEvent)
    key('e')
    await vi.waitFor(() => expect(vault.opened).toHaveLength(2))

    // Tab from a moon nothing embeds reaches its planet.
    s().select(imageKey('Projects/Gate/Art/sky.png'))
    s().cycleNeighbor(1)
    expect(s().hoveredId).toBe(folderKey('Projects/Gate/Art'))

    vault.fail = true
    await s().openImage('Projects/Gate/Art/ring.png')
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('ring.png') })

    await s().openVault(new MemoryVaultAdapter(notes(), { assets: pictures() }))
    await s().openImage('Projects/Gate/Art/ring.png')
    expect(s().toasts.at(-1)?.text).toMatch(/desktop app/)
  })
})

describe('importImages', () => {
  it('rebuilds the graph once for a whole drop, and once for a critique (adapters report each file as it is written)', async () => {
    const { s } = await freshStore()
    // A plain memory vault: it reports every new file to the app synchronously, like the desktop adapter.
    const vault = new MemoryVaultAdapter([{ path: 'Projects/Gate.md', content: project('Gate') }], { folders: ['Projects/Gate'] })
    await s().openVault(vault)
    const before = s().revision
    const got = await s().importImages(['a.png', 'b.png', 'c.png'].map((name) => ({ name, data: bytes(5) })), 'Projects/Gate/Art')
    expect(got).toEqual(['Projects/Gate/Art/a.png', 'Projects/Gate/Art/b.png', 'Projects/Gate/Art/c.png'])
    expect(s().revision).toBe(before + 1)
    expect([...s().assets.keys()].filter((p) => p.startsWith('Projects/Gate/Art/'))).toHaveLength(3)
    expect(s().folders.has('Projects/Gate/Art')).toBe(true)
    const mid = s().revision
    const saved = await s().saveCritique({ projectId: 'Projects/Gate', title: 'Study', png: PNG })
    expect(s().revision).toBe(mid + 1)
    expect(s().notes.has(saved.noteId)).toBe(true)
    expect(s().assets.has(saved.imagePath)).toBe(true)
  })

  const files = (): VaultFile[] => [
    { path: 'Projects/Gate.md', content: project('Gate') },
    { path: 'Projects/Gate/Art/Study.md', content: '# Study\n' },
    { path: 'inbox/Idea.md', content: '# Idea\n' },
    { path: 'Resources/Refs.md', content: '# Refs\n' },
  ]

  it('saves into the folder given, the selected folder, a selected project’s Critique planet, else Inbox', async () => {
    const { s } = await freshStore()
    const vault = new QuietVault(files(), { folders: ['Projects/Gate/critique'] })
    await s().openVault(vault)
    const one = async (name: string, folder?: string) => (await s().importImages([{ name, data: bytes(8) }], folder))[0]

    expect(await one('a.png', 'Projects/Gate/Art')).toBe('Projects/Gate/Art/a.png')
    // Applied at once (this vault's watcher never reports it), with the first new picture selected.
    expect(s().assets.has('Projects/Gate/Art/a.png')).toBe(true)
    expect(s().selectedId).toBe(imageKey('Projects/Gate/Art/a.png'))
    expect(vault.assetData('Projects/Gate/Art/a.png')).toEqual(bytes(8))

    s().select(folderKey('Resources'))
    expect(s().importTarget()).toBe('Resources')
    expect(await one('b.png')).toBe('Resources/b.png')
    // A project star or its note: the Critique planet, spelled as on disk.
    s().select(folderKey('Projects/Gate'))
    expect(await one('c.png')).toBe('Projects/Gate/critique/c.png')
    s().select('Projects/Gate')
    expect(await one('d.png')).toBe('Projects/Gate/critique/d.png')
    // Nothing selected: Inbox, as the vault spells it.
    s().select(null)
    expect(s().importTarget()).toBe('inbox')
    expect(await one('e.png')).toBe('inbox/e.png')

    const toast = s().toasts.at(-1)!
    expect(toast).toMatchObject({ kind: 'success', text: 'Added e.png to inbox', action: { label: 'Show' } })
    s().toggleLayout()
    expect(s().settings.layoutMode).toBe('constellation')
    // Show brings the picture's moon back: the system layout, its folder, selected.
    s().toastAction(toast.id)
    expect(s().settings.layoutMode).toBe('system')
    expect(s().selectedId).toBe(imageKey('inbox/e.png'))
  })

  it('creates a missing Critique planet, and never replaces a picture (numbered, any letter case, within one batch)', async () => {
    const { s } = await freshStore()
    const vault = new QuietVault(files(), { assets: [{ path: 'Projects/Gate/Art/gate.png', data: bytes(4) }] })
    await s().openVault(vault)
    s().select('Projects/Gate')
    expect(await s().importImages([{ name: 'first.png', data: bytes(3) }])).toEqual(['Projects/Gate/Critique/first.png'])
    expect(s().folders.has('Projects/Gate/Critique')).toBe(true)

    const got = await s().importImages(
      [
        { name: 'Gate.PNG', data: bytes(5) },
        { name: 'gate.png', data: bytes(6) },
      ],
      'Projects/Gate/Art',
    )
    expect(got).toEqual(['Projects/Gate/Art/Gate 2.PNG', 'Projects/Gate/Art/gate 3.png'])
    expect(vault.assetData('Projects/Gate/Art/gate.png')).toEqual(bytes(4))
    expect(s().toasts.at(-1)?.text).toBe('Added 2 pictures to Projects/Gate/Art')

    // On disk but not reported yet: the adapter refuses it, the next name is taken.
    await vault.createAsset('Projects/Gate/Art/late.png', bytes(2))
    expect(s().assets.has('Projects/Gate/Art/late.png')).toBe(false)
    expect(await s().importImages([{ name: 'LATE.png', data: bytes(7) }], 'Projects/Gate/Art')).toEqual(['Projects/Gate/Art/LATE 2.png'])
    expect(vault.assetData('Projects/Gate/Art/late.png')).toEqual(bytes(2))
  })

  it('takes pictures only, up to 40 MB, under names every OS and every embed accepts', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    const got = await s().importImages(
      [
        { name: 'notes.txt', data: bytes(3) },
        { name: 'evil.md', data: bytes(3) },
        { name: 'C:\\Users\\me\\Desktop\\my [ref] #1.webp', data: bytes(3) },
        { name: 'con.png', data: bytes(3) },
        // A plain ArrayBuffer, as a relay from another window may hand over.
        { name: 'CON.backup.gif', data: bytes(3).buffer as unknown as Uint8Array },
        { name: '..hidden.jpg', data: bytes(3) },
        { name: 'huge.png', data: new Uint8Array(40 * 1024 * 1024 + 1) },
      ],
      'Resources',
    )
    expect(got).toEqual(['Resources/my ref 1.webp', 'Resources/_con.png', 'Resources/_CON.backup.gif', 'Resources/hidden.jpg'])
    const texts = s().toasts.map((t) => t.text)
    expect(texts).toContain('2 files are not pictures (png, jpg, webp, gif, bmp, avif)')
    expect(texts).toContain('huge.png over 40 MB, not added')
    expect(vault.assetData('Resources/huge.png')).toBeNull()

    await s().openVault(new MemoryVaultAdapter(files(), { readOnly: true }))
    expect(await s().importImages([{ name: 'a.png', data: bytes(3) }], 'Resources')).toEqual([])
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'This vault is read-only' })
  })
})

describe('the Concept Forge link', () => {
  const files = (): VaultFile[] => [
    { path: 'Projects/Gate.md', content: project('Gate', 'updated: 2026-09-01\n') },
    { path: 'Projects/Gate/Art/Study.md', content: '# Study\n' },
    { path: 'Projects/Fresh.md', content: project('Fresh', 'updated: 2026-09-20\n') },
    { path: 'Projects/Old.md', content: '---\ntitle: Old\ntype: project\nstatus: done\nupdated: 2026-09-25\n---\n# Old\n' },
    { path: 'Archive/Dead.md', content: '---\ntitle: Dead\ntype: project\nstatus: active\n---\n# Dead\n' },
    { path: 'Inbox/Idea.md', content: '# Idea\n' },
  ]
  const grade = {
    letter: 'b+',
    overall: 82,
    drill: 'Gesture',
    opportunities: ['Push the line of action', 'Fewer, longer strokes'],
    strengths: ['Nice rhythm'],
    breakdown: { Gesture: 88, 'Line economy': 71 },
  }

  it('lists projects for the Forge: active first, done last, with where each critique lands', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(files(), { folders: ['Projects/Gate/CRITIQUE'] }))
    expect(s().forgeProjects()).toEqual([
      { id: 'Projects/Fresh', title: 'Fresh', status: 'active', home: null, critique: 'Projects/Fresh/Critique' },
      { id: 'Projects/Gate', title: 'Gate', status: 'active', home: 'Projects/Gate', critique: 'Projects/Gate/CRITIQUE' },
      { id: 'Projects/Old', title: 'Old', status: 'done', home: null, critique: 'Projects/Old/Critique' },
    ])
  })

  it('files a graded drawing: folders made, the PNG written, a note with the grade and tomorrow’s practice task', async () => {
    const { s } = await freshStore()
    const vault = new QuietVault(files())
    await s().openVault(vault)
    const saved = await s().saveCritique({ projectId: 'Projects/Fresh', title: '  Gesture   Warm-Up ', png: PNG, grade })
    const base = `Projects/Fresh/Critique/${TODAY} Gesture Warm-Up`
    expect(saved).toEqual({ noteId: base, notePath: `${base}.md`, imagePath: `${base}.png`, project: 'Fresh' })
    expect(s().folders.has('Projects/Fresh')).toBe(true)
    expect(s().folders.has('Projects/Fresh/Critique')).toBe(true)
    expect(vault.assetData(`${base}.png`)).toEqual(PNG)

    const raw = (await vault.read(`${base}.md`))!
    expect(s().notes.get(base)?.raw).toBe(raw)
    expect(raw).toBe(
      critiqueNote(
        {
          title: 'Gesture Warm-Up',
          project: 'Fresh',
          drill: 'Gesture',
          grade: 'B+',
          score: 82,
          scores: [
            { label: 'Gesture', score: 88 },
            { label: 'Line economy', score: 71 },
          ],
          fixes: ['Push the line of action', 'Fewer, longer strokes'],
          strengths: ['Nice rhythm'],
          deep: null,
        },
        `${TODAY} Gesture Warm-Up.png`,
        { date: TODAY, practiceDue: TOMORROW },
      ),
    )
    expect(raw).toContain('grade:: B+')
    expect(raw).toContain(`- [ ] Push the line of action 📅 ${TOMORROW}\n- [ ] Fewer, longer strokes\n`)
    expect(s().graph!.outlinks.get(base)?.has(imageKey(`${base}.png`))).toBe(true)
    // Tomorrow's brief lists the practice task.
    const tomorrow = dailyBrief(s().notes.values(), { date: TOMORROW, folders: s().folders })
    expect(tomorrow.today.map((t) => [t.label, t.projectTitle])).toContainEqual(['Push the line of action', 'Fresh'])

    const toast = s().toasts.at(-1)!
    expect(toast).toMatchObject({ kind: 'success', text: 'Critique saved to Fresh ▸ Critique', action: { label: 'Show' } })
    s().setView('projects')
    s().toastAction(toast.id)
    expect(s().selectedId).toBe(base)
    expect(s().view).toBe('graph')

    const quiet = await s().saveCritique({ projectId: 'Projects/Fresh', title: 'No practice', png: PNG, grade, practiceTomorrow: false })
    expect(await vault.read(quiet.notePath)).not.toContain('📅')
  })

  it('reuses the Critique folder as spelled and numbers a drawing whose name is taken', async () => {
    const { s } = await freshStore()
    const vault = new QuietVault(files(), { folders: ['Projects/Gate/critique'] })
    await s().openVault(vault)
    const dir = 'Projects/Gate/critique'
    const first = await s().saveCritique({ projectId: 'Projects/Gate', title: 'Study', png: PNG })
    const second = await s().saveCritique({ projectId: 'Projects/Gate', title: 'Study', png: PNG })
    expect(first.imagePath).toBe(`${dir}/${TODAY} Study.png`)
    expect(second).toMatchObject({ imagePath: `${dir}/${TODAY} Study 2.png`, notePath: `${dir}/${TODAY} Study 2.md` })
    expect(await vault.read(second.notePath)).toContain(`![[${TODAY} Study 2.png]]`)

    // A note by that name the store knows: both files take the next free name. One on disk the store
    // has not heard of yet: the picture keeps its name, the note is numbered (and never replaces the file).
    await vault.create(`${dir}/${TODAY} Lone.md`, '# mine\n')
    await s().writeNote(`${dir}/${TODAY} Taken.md`, '# mine too\n')
    const lone = await s().saveCritique({ projectId: 'Projects/Gate', title: 'Lone', png: PNG })
    expect(lone).toMatchObject({ imagePath: `${dir}/${TODAY} Lone.png`, notePath: `${dir}/${TODAY} Lone 2.md` })
    const taken = await s().saveCritique({ projectId: 'Projects/Gate', title: 'Taken', png: PNG })
    expect(taken).toMatchObject({ imagePath: `${dir}/${TODAY} Taken 2.png`, notePath: `${dir}/${TODAY} Taken 2.md` })
    expect(await vault.read(`${dir}/${TODAY} Lone.md`)).toBe('# mine\n')
    // Lone 2.md embeds Lone.png by its file name, found next to it.
    expect(s().graph!.outlinks.get(`${dir}/${TODAY} Lone 2`)?.has(imageKey(`${dir}/${TODAY} Lone.png`))).toBe(true)

    // No title: the drill's name, else "Drawing".
    expect((await s().saveCritique({ projectId: 'Projects/Gate', title: '', png: PNG, grade: { drill: 'Value Study' } })).imagePath).toBe(
      `${dir}/${TODAY} Value Study.png`,
    )
    expect((await s().saveCritique({ projectId: 'Projects/Gate', title: ' ', png: PNG })).imagePath).toBe(`${dir}/${TODAY} Drawing.png`)
  })

  it('keeps pictures and critiques inside a drive of a multi-root vault', async () => {
    const { s } = await freshStore()
    class TwoRoots extends MemoryVaultAdapter {
      readonly roots: VaultRootInfo[] = [
        { path: 'D:\\', mount: 'D', label: 'D:\\' },
        { path: 'F:\\', mount: 'F', label: 'F:\\' },
      ]
    }
    const vault = new TwoRoots([
      { path: 'D/Notes/a.md', content: '# a\n' },
      // Its home is named but not made yet, relative to its own drive.
      { path: 'F/Projects/Portal.md', content: project('Portal', 'folder: Games/Portal\n') },
    ])
    await s().openVault(vault)
    s().select(folderKey(''))
    expect(s().importTarget()).toBe('D/Inbox')
    expect(s().importTarget('')).toBe('D/Inbox')
    s().select(folderKey('F'))
    expect(s().importTarget()).toBe('F')
    expect(s().forgeProjects()).toEqual([{ id: 'F/Projects/Portal', title: 'Portal', status: 'active', home: null, critique: 'F/Games/Portal/Critique' }])
    const saved = await s().saveCritique({ projectId: 'F/Projects/Portal', title: 'Gate', png: PNG })
    expect(saved.imagePath).toBe(`F/Games/Portal/Critique/${TODAY} Gate.png`)
    expect(s().folders.has('F/Games/Portal/Critique')).toBe(true)
  })

  it('rejects with a readable message: no vault, a project that is gone, a read-only vault, not a PNG', async () => {
    const { s } = await freshStore()
    const save = (projectId: string, png = PNG) => s().saveCritique({ projectId, title: 'x', png })
    await expect(save('Projects/Gate')).rejects.toThrow('Open your vault in Aether Brain first')

    await s().openVault(new MemoryVaultAdapter(files()))
    await expect(save('Projects/Nope')).rejects.toThrow(/no longer in the vault/)
    await expect(save('Inbox/Idea')).rejects.toThrow(/no longer in the vault/)
    await expect(save(folderKey('Projects/Gate'))).rejects.toThrow(/no longer in the vault/)
    await expect(save('Projects/Gate', bytes(20))).rejects.toThrow('The drawing is not a PNG')
    await expect(save('Projects/Gate', new Uint8Array(0))).rejects.toThrow('The drawing is empty')
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Could not save the critique: The drawing is empty' })

    await s().openVault(new MemoryVaultAdapter(files(), { readOnly: true }))
    await expect(save('Projects/Gate')).rejects.toThrow('This vault is read-only')
  })
})

describe('the demo vault', () => {
  const root = fileURLToPath(new URL('../../../vault-demo', import.meta.url))
  const walk = (dir: string, keep: (name: string) => boolean): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), keep) : keep(e.name) ? [relative(root, join(dir, e.name)).split('\\').join('/')] : [],
    )

  it('has concept art as moons of PORTALz/Art, an embedded portal ring, and a critique pair with dated tasks', async () => {
    const { s } = await freshStore()
    const notes = walk(root, (n) => n.endsWith('.md')).map((path) => ({ path, content: readFileSync(join(root, path), 'utf8') }))
    const pictures = walk(root, isImagePath).map((path) => ({ path, data: new Uint8Array(readFileSync(join(root, path))) }))
    expect(pictures.length).toBe(8)
    expect(pictures.reduce((n, p) => n + p.data.byteLength, 0)).toBeLessThan(250 * 1024)
    for (const p of pictures) expect([...p.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    await s().openVault(new MemoryVaultAdapter(notes, { assets: pictures }))
    expect(s().notes.size).toBe(71)
    const art = s().graph!.nodes[s().graph!.index.get(folderKey('Projects/PORTALz/Art'))!]!
    expect(art.folder).toMatchObject({ images: 7, shownImages: 7 })
    const ring = imageKey('Projects/PORTALz/Art/portal-ring.png')
    expect(s().graph!.outlinks.get('Projects/PORTALz/Design/Gate Opening Sequence')?.has(ring)).toBe(true)

    const critique = 'Projects/ConceptForge/Critique/2026-09-28 Value Study'
    expect(s().graph!.outlinks.get(critique)?.has(imageKey(`${critique}.png`))).toBe(true)
    expect(s().notes.get(critique)!.raw).toContain('grade:: B')

    const brief = dailyBrief(s().notes.values(), { date: '2026-09-30', folders: s().folders })
    expect(brief.overdue.map((t) => t.projectTitle)).toEqual(['ConceptForge'])
    expect(brief.today.map((t) => [t.reason, t.projectTitle])).toEqual([
      ['scheduled', 'PORTALz'],
      ['flagged', 'ConceptForge'],
    ])
    expect(dailyBrief(s().notes.values(), { date: '2026-10-01', folders: s().folders }).today.filter((t) => t.reason === 'due')).toHaveLength(2)
  })

  it('bundles the pictures in the demo adapter: listed, create-only over them, pictures added in the app kept', async () => {
    const { createDemoVault } = await import('../src/vault/demo')
    const vault = await createDemoVault()
    const listed = (await vault.listAssets()).map((a) => a.path)
    expect(listed).toContain('Projects/PORTALz/Art/portal-ring.png')
    expect(listed).toContain('Projects/ConceptForge/Critique/2026-09-28 Value Study.png')
    expect(listed).toHaveLength(8)
    const err = await vault.createAsset('projects/portalz/art/PORTAL-RING.png', PNG).catch((e: unknown) => e)
    expect(String(err)).toMatch(/EEXIST/)
    await vault.createAsset('Projects/PORTALz/Art/dropped.png', PNG)
    expect((await vault.listAssets()).map((a) => a.path)).toContain('Projects/PORTALz/Art/dropped.png')
    expect((await vault.thumbnail('Projects/PORTALz/Art/dropped.png', 128))?.size).toBe(PNG.byteLength)
    expect(await vault.listFolders()).toContain('Projects/PORTALz/Art')
  })
})
