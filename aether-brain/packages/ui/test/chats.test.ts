import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, TRANSCRIPT_HEADING, folderKey, readChatExport, tasksOf, type ChatArchive } from '@aether/core'

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

async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const store = await import('../src/store')
  const chats = await import('../src/components/chats')
  const { COMMANDS } = await import('../src/commands')
  return { s: () => store.useAether.getState(), chats, commands: COMMANDS }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])

const claude = (extra: object[] = []) => [
  {
    uuid: 'c-1',
    name: 'Portal lighting',
    created_at: '2026-03-02T14:05:00Z',
    updated_at: '2026-03-02T14:06:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', created_at: '2026-03-02T14:05:00Z', text: 'How do I light a portal? - [ ] not a task', content: [] },
      { uuid: 'm2', sender: 'assistant', created_at: '2026-03-02T14:06:00Z', text: 'Rim light.\n\n- [ ] bloom pass\n\nSee [[Gate]] #lighting', content: [] },
      ...extra,
    ],
  },
]
const claudeProjects = [{ uuid: 'p-1', name: 'PORTALz', description: 'The portal game.', prompt_template: 'Be my art director.', docs: [{ filename: 'lore.md', content: '# Lore' }] }]
const chatgpt = [
  {
    title: 'Monolith ideas',
    create_time: 1772600000,
    update_time: 1772600100,
    conversation_id: 'g-1',
    current_node: 'n2',
    mapping: {
      n1: { id: 'n1', parent: null, children: ['n2'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Draw a monolith'] }, recipient: 'all', metadata: {} } },
      n2: { id: 'n2', parent: 'n1', children: [], message: { author: { role: 'tool' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-AbC' }] }, recipient: 'all', metadata: {} } },
    },
  },
]

const archiveOf = (claudeConvs = claude()): ChatArchive =>
  readChatExport([
    { name: 'conversations.json', text: JSON.stringify(claudeConvs) },
    { name: 'projects.json', text: JSON.stringify(claudeProjects) },
    { name: 'gpt/conversations.json', text: JSON.stringify(chatgpt) },
  ])

const project = (title: string) => `---\ntitle: ${title}\ntype: project\nstatus: active\n---\n# ${title}\n\n## To do\n\n- [ ] First step\n`

function vault() {
  return new MemoryVaultAdapter(
    [
      { path: 'Projects/PORTALz.md', content: project('PORTALz') },
      { path: 'Resources/Readme.md', content: '# Readme' },
    ],
    { folders: ['Projects/PORTALz', 'Resources'] },
  )
}

/** A zip of `files`, entries stored (no compression). */
function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  const le = (n: number, b: number) => Array.from({ length: b }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 0xff)
  const enc = new TextEncoder()
  const out: number[] = []
  const cd: number[] = []
  let count = 0
  for (const [name, content] of Object.entries(files)) {
    const data = [...(typeof content === 'string' ? enc.encode(content) : content)]
    const nb = [...enc.encode(name)]
    const at = out.length
    out.push(...le(0x04034b50, 4), ...le(20, 2), ...le(0x800, 2), ...le(0, 2), ...le(0, 8), ...le(data.length, 4), ...le(data.length, 4), ...le(nb.length, 2), ...le(0, 2), ...nb, ...data)
    cd.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(0x800, 2), ...le(0, 2), ...le(0, 8), ...le(data.length, 4), ...le(data.length, 4), ...le(nb.length, 2), ...le(0, 6), ...le(0, 6), ...le(at, 4), ...nb)
    count++
  }
  const cdAt = out.length
  return new Uint8Array([...out, ...cd, ...le(0x06054b50, 4), ...le(0, 4), ...le(count, 2), ...le(count, 2), ...le(cd.length, 4), ...le(cdAt, 4), ...le(0, 2)])
}

describe('importing AI chats', () => {
  it('writes chats, projects and pictures into Resources/AI Chats in one go, after asking', async () => {
    const { s } = await freshStore()
    const v = vault()
    await s().openVault(v)
    const asked: string[] = []
    const reads: string[] = []
    const result = await s().importChats({
      archive: archiveOf(),
      pictures: {
        files: ['0/file-AbC-monolith.png'],
        read: async (p) => {
          reads.push(p)
          return PNG
        },
      },
      confirm: (plan, base) => {
        asked.push(base, String(plan.create.length))
        return true
      },
    })
    expect(asked).toEqual(['Resources/AI Chats', '4'])
    expect(result).toMatchObject({ base: 'Resources/AI Chats', created: 4, updated: 0, pictures: 1, failed: [] })
    expect(reads).toEqual(['0/file-AbC-monolith.png'])
    const paths = [...s().notes.values()].map((n) => n.meta.path).sort()
    // The Claude project has the name of an Aether project: it joins that project's AI Chats planet.
    expect(paths).toEqual([
      'Projects/PORTALz.md',
      'Projects/PORTALz/AI Chats/Knowledge/PORTALz – lore.md',
      'Projects/PORTALz/AI Chats/PORTALz (Claude project).md',
      'Resources/AI Chats/ChatGPT/2026-03-04 Monolith ideas.md',
      'Resources/AI Chats/Claude/2026-03-02 Portal lighting.md',
      'Resources/Readme.md',
    ])
    expect([...s().assets.keys()]).toEqual(['Resources/AI Chats/ChatGPT/Pictures/2026-03-04 Monolith ideas 1.png'])
    // Nothing a chat says becomes a task, a tag or a link of the brain.
    const chat = s().notes.get('Resources/AI Chats/Claude/2026-03-02 Portal lighting')!
    expect(tasksOf(chat)).toEqual([])
    expect(chat.meta.tags).toEqual(['ai-chat', 'claude'])
    expect(chat.links).toEqual([])
    expect(s().brief?.total ?? 0).toBe(1)
    expect(s().folders.has('Resources/AI Chats/Claude')).toBe(true)
    expect(s().toasts.at(-1)?.text).toMatch(/AI chats imported: 4 notes, 1 picture → Resources\/AI Chats/)
  })

  it('cancelled: nothing is written', async () => {
    const { s } = await freshStore()
    const v = vault()
    await s().openVault(v)
    const before = [...s().notes.keys()]
    expect(await s().importChats({ archive: archiveOf(), confirm: () => false })).toBeNull()
    expect([...s().notes.keys()]).toEqual(before)
    expect((await v.list()).length).toBe(2)
  })

  it('re-import: nothing new is a no-op; a chat that grew gets its transcript rewritten, the note above it kept', async () => {
    const { s } = await freshStore()
    const v = vault()
    await s().openVault(v)
    await s().importChats({ archive: archiveOf() })
    const id = 'Resources/AI Chats/Claude/2026-03-02 Portal lighting'
    const path = `${id}.md`
    const raw = (await v.read(path))!
    await v.write(path, raw.replace(TRANSCRIPT_HEADING, `My take: rim light it is.\n\n${TRANSCRIPT_HEADING}`))
    await new Promise((r) => setTimeout(r, 0))
    expect(await s().importChats({ archive: archiveOf() })).toBeNull()
    expect(s().toasts.at(-1)?.text).toMatch(/Nothing new: 2 chats already in your brain/)

    const grown = archiveOf(claude([{ uuid: 'm3', sender: 'human', created_at: '2026-03-05T10:00:00Z', text: 'And the fog?', content: [] }]))
    const result = await s().importChats({ archive: grown })
    expect(result).toMatchObject({ created: 0, updated: 1 })
    const after = (await v.read(path))!
    expect(after).toContain('My take: rim light it is.')
    expect(after).toContain('And the fog?')
    expect(after).toContain('*3 messages')
    expect(s().notes.get(id)?.raw).toBe(after)
  })

  it('refuses a read-only vault and an export without chats', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter([], { readOnly: true }))
    expect(await s().importChats({ archive: archiveOf() })).toBeNull()
    expect(s().toasts.at(-1)?.text).toBe('This vault is read-only')
    await s().openVault(vault())
    expect(await s().importChats({ archive: readChatExport([{ name: 'x.json', text: '[]' }]) })).toBeNull()
    expect(s().toasts.at(-1)?.text).toMatch(/No Claude or ChatGPT chats found/)
  })

  it('reads a real export zip: the chats JSON and the pictures, entry by entry', async () => {
    const { s, chats } = await freshStore()
    await s().openVault(vault())
    const zip = zipOf({
      'conversations.json': JSON.stringify(chatgpt),
      'user.json': '{"email":"x"}',
      'file-AbC-monolith.png': PNG,
      'dalle-generations/file-Other-x.webp': PNG,
    })
    const file = new File([zip], 'chatgpt-export.zip', { type: 'application/zip' })
    const input = await chats.readChatFiles([file])
    expect(input?.archive.conversations.map((c) => c.title)).toEqual(['Monolith ideas'])
    expect(input?.archive.files).toEqual(['chatgpt-export.zip/conversations.json'])
    expect(input?.pictures?.files.sort()).toEqual(['0/dalle-generations/file-Other-x.webp', '0/file-AbC-monolith.png'])
    expect([...(await input!.pictures!.read('0/file-AbC-monolith.png'))]).toEqual([...PNG])
    const result = await s().importChats(input!)
    expect(result).toMatchObject({ created: 1, pictures: 1 })
    expect(s().notes.get('Resources/AI Chats/ChatGPT/2026-03-04 Monolith ideas')?.raw).toContain('![[2026-03-04 Monolith ideas 1.png]]')
    // A file that is no export is reported, not read.
    expect(await chats.readChatFiles([new File(['x'], 'notes.txt')])).toBeNull()
    expect(s().toasts.at(-1)?.text).toMatch(/notes\.txt is not a chat export/)
  })

  it('has a palette command and the i key', async () => {
    const { s, commands } = await freshStore()
    await s().openVault(vault())
    const cmd = commands.find((c) => c.id === 'import-chats')
    expect(cmd?.keys).toBe('i')
    expect(cmd?.when?.(s())).toBe(true)
    expect(s().chatImportBase()).toBe('Resources/AI Chats')
    await s().openVault(new MemoryVaultAdapter([{ path: 'x.md', content: '# x' }]))
    expect(s().chatImportBase()).toBe('AI Chats')
    expect(s().graph?.index.has(folderKey('AI Chats'))).toBe(false)
  })
})

/** A memory vault whose picture writes wait for `release()` (a write in progress while the store holds changes). */
class SlowPictures extends MemoryVaultAdapter {
  private gate: Promise<void> | null = null
  release = () => {}
  hold(): void {
    this.gate = new Promise((r) => (this.release = r))
  }
  override async createAsset(path: string, data: Uint8Array): Promise<void> {
    if (this.gate) await this.gate
    return super.createAsset(path, data)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('importing AI chats: edits made meanwhile, one import at a time, another vault', () => {
  it('edits made while changes are held start from the disk (two tasks added during a picture write both stay)', async () => {
    const { s } = await freshStore()
    const v = new SlowPictures([{ path: 'Projects/PORTALz.md', content: project('PORTALz') }], { folders: ['Projects/PORTALz'] })
    await s().openVault(v)
    v.hold()
    const drop = s().importImages([{ name: 'gate.png', data: PNG }], 'Projects/PORTALz')
    await tick()
    await s().addTask('Projects/PORTALz', 'Task A')
    await s().addTask('Projects/PORTALz', 'Task B')
    v.release()
    await drop
    const disk = (await v.read('Projects/PORTALz.md'))!
    expect(disk).toContain('- [ ] Task A')
    expect(disk).toContain('- [ ] Task B')
    expect(s().notes.get('Projects/PORTALz')?.raw).toBe(disk)
  })

  it('a chat open with unsaved edits: the draft is saved first and kept when its transcript is updated', async () => {
    const { s } = await freshStore()
    const v = vault()
    await s().openVault(v)
    await s().importChats({ archive: archiveOf() })
    const id = 'Resources/AI Chats/Claude/2026-03-02 Portal lighting'
    s().openNote(id)
    s().setDraft(s().draft.replace(TRANSCRIPT_HEADING, `Draft thought.\n\n${TRANSCRIPT_HEADING}`))
    const grown = archiveOf(claude([{ uuid: 'm3', sender: 'human', created_at: '2026-03-05T10:00:00Z', text: 'And the fog?', content: [] }]))
    expect(await s().importChats({ archive: grown })).toMatchObject({ updated: 1 })
    const disk = (await v.read(`${id}.md`))!
    expect(disk).toContain('Draft thought.')
    expect(disk).toContain('And the fog?')
  })

  it('runs one import at a time: a second one while the first runs is refused, not doubled', async () => {
    const { s } = await freshStore()
    const v = vault()
    await s().openVault(v)
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const first = s().importChats({ archive: archiveOf(), confirm: () => gate.then(() => true) })
    await tick()
    expect(await s().importChats({ archive: archiveOf() })).toBeNull()
    expect(s().toasts.at(-1)?.text).toMatch(/already running/)
    release()
    expect(await first).toMatchObject({ created: 4 })
    const paths = [...s().notes.keys()].filter((k) => k.includes('Portal lighting'))
    expect(paths).toEqual(['Resources/AI Chats/Claude/2026-03-02 Portal lighting'])
  })

  it('stops when another vault is opened, and writes nothing into it', async () => {
    const { s } = await freshStore()
    const v1 = vault()
    const v2 = new MemoryVaultAdapter([{ path: 'Other.md', content: '# Other' }], { folders: ['Resources'] })
    await s().openVault(v1)
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const run = s().importChats({ archive: archiveOf(), confirm: () => gate.then(() => true) })
    await tick()
    await s().openVault(v2)
    release()
    expect(await run).toBeNull()
    expect((await v2.list()).map((f) => f.path)).toEqual(['Other.md'])
    expect([...s().notes.keys()]).toEqual(['Other'])
  })

  it('a project whose name starts with a dot (.NET) is still imported, under a name the brain shows', async () => {
    const { s } = await freshStore()
    await s().openVault(vault())
    const archive = readChatExport([{ name: 'projects.json', text: JSON.stringify([{ uuid: 'p-9', name: '.NET migration', prompt_template: 'x', docs: [{ filename: '.env notes.md', content: 'hi' }] }]) }])
    expect(await s().importChats({ archive })).toMatchObject({ created: 2, failed: [] })
    expect([...s().notes.keys()].filter((k) => k.startsWith('Resources/AI Chats')).sort()).toEqual([
      'Resources/AI Chats/Claude/NET migration/Knowledge/NET migration – env notes',
      'Resources/AI Chats/Claude/NET migration/NET migration (Claude project)',
    ])
  })
})

