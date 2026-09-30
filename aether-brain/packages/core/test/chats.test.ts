import { deflateRawSync } from 'node:zlib'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_HEADING,
  ZipError,
  applyChatUpdate,
  assetFileId,
  bytesZipSource,
  TRANSCRIPT_END,
  blanketInert,
  chatUrlOf,
  closeFences,
  importedNotes,
  inertMarkdown,
  parseMarkdown,
  replaceSummary,
  tameChatMarkdown,
  isChatExportJson,
  parseNote,
  planChatImport,
  readChatExport,
  remarkLiteralHashes,
  remarkWikilink,
  renderChatNote,
  renderTranscript,
  sectionOf,
  splitFrontmatter,
  tasksOf,
  zipEntries,
  zipRead,
  zipReadText,
  type ChatConversation,
  type ParsedNote,
} from '../src'

// ------------------------------------------------------------------ zip fixtures

const enc = new TextEncoder()

function le(n: number, bytes: number): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes; i++) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff)
  return out
}

/** A zip of `files` (deflated unless `store`), optionally with zip64 records for everything. */
function makeZip(files: Record<string, string | Uint8Array>, opts: { store?: boolean; zip64?: boolean } = {}): Uint8Array {
  const parts: number[] = []
  const central: number[] = []
  let count = 0
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    const body = opts.store ? data : new Uint8Array(deflateRawSync(data))
    const method = opts.store ? 0 : 8
    const nameBytes = [...enc.encode(name)]
    const offset = parts.length
    const z64 = !!opts.zip64
    const extra = z64 ? [...le(1, 2), ...le(24, 2), ...le(data.length, 8), ...le(body.length, 8), ...le(offset, 8)] : []
    parts.push(...le(0x04034b50, 4), ...le(45, 2), ...le(0x800, 2), ...le(method, 2), ...le(0, 4), ...le(0, 4))
    parts.push(...le(z64 ? 0xffffffff : body.length, 4), ...le(z64 ? 0xffffffff : data.length, 4), ...le(nameBytes.length, 2), ...le(0, 2), ...nameBytes, ...body)
    central.push(...le(0x02014b50, 4), ...le(45, 2), ...le(45, 2), ...le(0x800, 2), ...le(method, 2), ...le(0, 4), ...le(0, 4))
    central.push(...le(z64 ? 0xffffffff : body.length, 4), ...le(z64 ? 0xffffffff : data.length, 4), ...le(nameBytes.length, 2), ...le(extra.length, 2), ...le(0, 2))
    central.push(...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(z64 ? 0xffffffff : offset, 4), ...nameBytes, ...extra)
    count++
  }
  const cdOffset = parts.length
  const tail: number[] = []
  if (opts.zip64) {
    const eocd64At = cdOffset + central.length
    tail.push(...le(0x06064b50, 4), ...le(44, 8), ...le(45, 2), ...le(45, 2), ...le(0, 4), ...le(0, 4))
    tail.push(...le(count, 8), ...le(count, 8), ...le(central.length, 8), ...le(cdOffset, 8))
    tail.push(...le(0x07064b50, 4), ...le(0, 4), ...le(eocd64At, 8), ...le(1, 4))
    tail.push(...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(0xffff, 2), ...le(0xffff, 2), ...le(0xffffffff, 4), ...le(0xffffffff, 4), ...le(0, 2))
  } else {
    tail.push(...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(count, 2), ...le(count, 2), ...le(central.length, 4), ...le(cdOffset, 4), ...le(0, 2))
  }
  return new Uint8Array([...parts, ...central, ...tail])
}

describe('zip reader', () => {
  it('lists and reads deflated, stored and zip64 archives', async () => {
    for (const opts of [{}, { store: true }, { zip64: true }]) {
      const zip = makeZip({ 'conversations.json': '[{"a":"ü✓"}]', 'dir/file-AbC-x.png': new Uint8Array([137, 80, 78, 71]) }, opts)
      const src = bytesZipSource(zip)
      const entries = await zipEntries(src)
      expect(entries.map((e) => e.name)).toEqual(['conversations.json', 'dir/file-AbC-x.png'])
      expect(await zipReadText(src, entries[0]!)).toBe('[{"a":"ü✓"}]')
      expect([...(await zipRead(src, entries[1]!))]).toEqual([137, 80, 78, 71])
    }
  })

  it('refuses what is not a zip, a cut-off download and a bomb', async () => {
    await expect(zipEntries(bytesZipSource(enc.encode('{"not":"a zip"} and some more text to pass 22 bytes')))).rejects.toBeInstanceOf(ZipError)
    const zip = makeZip({ 'conversations.json': 'x'.repeat(5000) })
    // Central directory promised beyond the end.
    await expect(zipEntries(bytesZipSource(zip.subarray(0, 40)))).rejects.toBeInstanceOf(ZipError)
    const src = bytesZipSource(zip)
    const [entry] = await zipEntries(src)
    await expect(zipRead(src, entry!, 1000)).rejects.toThrow(/too large/)
    // The stated size can lie: the inflater stops at the cap anyway.
    await expect(zipRead(src, { ...entry!, size: 10 }, 1000)).rejects.toThrow(/too large/)
  })
})

// ------------------------------------------------------------------ export fixtures

const claudeConversations = [
  {
    uuid: 'c-1',
    name: 'Portal lighting',
    created_at: '2026-03-02T14:05:00Z',
    updated_at: '2026-03-04T09:00:00Z',
    current_leaf_message_uuid: 'm4',
    chat_messages: [
      { uuid: 'm1', sender: 'human', created_at: '2026-03-02T14:05:00Z', text: 'How do I light a portal?', content: [{ type: 'text', text: 'How do I light a portal? #portal [[Gate]]' }], parent_message_uuid: '00000000-0000-4000-8000-000000000000', attachments: [{ file_name: 'brief.txt', extracted_content: 'Brief: - [ ] ship it' }] },
      { uuid: 'm2', sender: 'assistant', created_at: '2026-03-02T14:06:00Z', text: 'old answer', content: [{ type: 'text', text: 'old answer' }], parent_message_uuid: 'm1' },
      {
        uuid: 'm3',
        sender: 'assistant',
        created_at: '2026-03-02T14:07:00Z',
        text: '',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'Use rim light.\n\n- [ ] add bloom\n\n```python\n# comment #tag\nx = [[1, 2]]\n```' },
          { type: 'tool_use', name: 'artifacts', input: { id: 'a', type: 'application/vnd.ant.code', language: 'python', title: 'Glow shader', command: 'create', content: 'glow = 1  # [[not a link]]\n```\nnested\n```' } },
          { type: 'tool_use', name: 'web_search', input: { query: 'x' } },
        ],
        parent_message_uuid: 'm1',
      },
      { uuid: 'm4', sender: 'human', created_at: '2026-03-04T09:00:00Z', text: 'Thanks!', content: [], parent_message_uuid: 'm3', files: [{ file_name: 'sketch.png' }] },
    ],
  },
  { uuid: 'c-2', name: '', summary: '', created_at: '2026-03-02T20:00:00Z', updated_at: '2026-03-02T20:00:00Z', chat_messages: [{ uuid: 'x', sender: 'human', text: 'New chat about monoliths', content: [] }] },
  { uuid: 'c-3', name: 'Portal lighting', created_at: '2026-03-02T21:00:00Z', updated_at: '2026-03-02T21:00:00Z', project_uuid: 'p-1', chat_messages: [{ uuid: 'y', sender: 'human', text: 'Same title, same day', content: [] }] },
]

const claudeProjects = [
  { uuid: 'p-1', name: 'PORTALz', description: 'The portal game.', prompt_template: 'You are my art director. #lore', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', docs: [{ filename: 'lore bible.md', content: '# Lore\n\n- [ ] write act 2\n[[Portal]]' }, { filename: 'gen.py', content: 'print("hi")' }] },
  { uuid: 'p-2', name: 'How to use Claude', is_starter_project: true, prompt_template: '', docs: [] },
]

const chatgptConversations = [
  {
    title: 'Monolith ideas',
    create_time: 1772600000,
    update_time: 1772603600,
    conversation_id: 'g-1',
    current_node: 'n5',
    gizmo_id: 'g-p-abcdef1234567890',
    default_model_slug: 'gpt-4o',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['n0'] },
      n0: { id: 'n0', parent: 'root', children: ['n1'], message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } } },
      n1: { id: 'n1', parent: 'n0', children: ['n2a', 'n2'], message: { author: { role: 'user' }, create_time: 1772600000, content: { content_type: 'text', parts: ['Draw a monolith'] }, recipient: 'all', metadata: {} } },
      n2a: { id: 'n2a', parent: 'n1', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['abandoned branch'] }, recipient: 'all', metadata: {} } },
      n2: { id: 'n2', parent: 'n1', children: ['n3'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['{"prompt":"a black monolith in rain"}'] }, recipient: 'dalle.text2im', metadata: {} } },
      n3: { id: 'n3', parent: 'n2', children: ['n4'], message: { author: { role: 'tool', name: 'dalle.text2im' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-AbC123', metadata: { dalle: { prompt: 'a black monolith in rain' } } }] }, recipient: 'all', metadata: {} } },
      n4: { id: 'n4', parent: 'n3', children: ['n5'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Here it is 【3†source】 with #bold ideas'] }, recipient: 'all', metadata: {} } },
      n5: { id: 'n5', parent: 'n4', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['{"name":"Lore doc","type":"document","content":"# Monolith\\n- [ ] carve runes"}'] }, recipient: 'canmore.create_textdoc', metadata: {} } },
    },
  },
]

const exportFiles = [
  { name: 'conversations.json', text: JSON.stringify(claudeConversations) },
  { name: 'projects.json', text: JSON.stringify(claudeProjects) },
  { name: 'chatgpt/conversations.json', text: JSON.stringify(chatgptConversations) },
]

const archive = () => readChatExport(exportFiles)

/** Every link, tag and task a note gives the brain. */
function brainOf(content: string, path = 'AI Chats/x.md'): { links: string[]; tags: string[]; tasks: string[]; note: ParsedNote } {
  const note = parseNote({ path, content })
  return { links: note.links.map((l) => l.to), tags: note.meta.tags, tasks: tasksOf(note).map((t) => t.text), note }
}

describe('reading exports', () => {
  it('picks the export files worth reading', () => {
    expect(isChatExportJson('conversations.json')).toBe(true)
    expect(isChatExportJson('export/conversations-000.json')).toBe(true)
    expect(isChatExportJson('projects/PORTALz.json')).toBe(true)
    expect(isChatExportJson('users.json')).toBe(false)
    expect(isChatExportJson('memories.json')).toBe(false)
    expect(isChatExportJson('__MACOSX/conversations.json')).toBe(false)
  })

  it('reads Claude chats: the shown branch, text, artifacts, attachments; no thinking or tool noise', () => {
    const a = archive()
    const c = a.conversations.find((x) => x.id === 'c-1')!
    expect(c.source).toBe('claude')
    expect(c.url).toBe('https://claude.ai/chat/c-1')
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(c.messages[1]!.text).toContain('Use rim light.')
    expect(JSON.stringify(c)).not.toContain('old answer')
    expect(JSON.stringify(c)).not.toContain('secret reasoning')
    expect(c.messages[1]!.artifacts).toEqual([{ title: 'Glow shader', language: 'python', content: 'glow = 1  # [[not a link]]\n```\nnested\n```' }])
    expect(c.messages[0]!.attachments).toEqual([{ name: 'brief.txt', text: 'Brief: - [ ] ship it' }])
    expect(c.messages[2]!.attachments).toEqual([{ name: 'sketch.png' }])
    // An untitled chat is named after its first message.
    expect(a.conversations.find((x) => x.id === 'c-2')!.title).toBe('New chat about monoliths')
    expect(a.conversations.find((x) => x.id === 'c-3')!.projectId).toBe('p-1')
  })

  it('reads Claude projects (both export layouts) and skips the starter project', () => {
    const a = readChatExport([{ name: 'projects/PORTALz.json', text: JSON.stringify(claudeProjects[0]) }, { name: 'projects.json', text: JSON.stringify({ projects: claudeProjects }) }])
    expect(a.projects).toHaveLength(1)
    expect(a.projects[0]).toMatchObject({ name: 'PORTALz', instructions: 'You are my art director. #lore', url: 'https://claude.ai/project/p-1' })
    expect(a.projects[0]!.docs.map((d) => d.name)).toEqual(['lore bible.md', 'gen.py'])
  })

  it('reads ChatGPT trees: the current branch, generated pictures and prompts, canvases; hidden and tool messages dropped', () => {
    const c = archive().conversations.find((x) => x.source === 'chatgpt')!
    expect(c.url).toBe('https://chatgpt.com/c/g-1')
    expect(c.projectId).toBe('g-p-abcdef1234567890')
    expect(c.model).toBe('gpt-4o')
    expect(c.created).toBe(new Date(1772600000 * 1000).toISOString())
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const reply = c.messages[1]!
    expect(reply.text).toContain('Image prompt:* a black monolith in rain')
    expect(reply.text).toContain('Here it is  with #bold ideas')
    expect(reply.text).not.toContain('abandoned')
    expect(reply.images).toEqual([{ fileId: 'file-AbC123', prompt: 'a black monolith in rain' }])
    expect(reply.artifacts).toEqual([{ title: 'Lore doc', language: 'markdown', content: '# Monolith\n- [ ] carve runes' }])
  })

  it('reports files it does not understand instead of failing', () => {
    const a = readChatExport([{ name: 'conversations.json', text: '{oops' }, { name: 'projects.json', text: '{"hello":1}' }])
    expect(a.conversations).toEqual([])
    expect(a.warnings).toHaveLength(2)
  })

  it('maps asset pointers to file ids', () => {
    expect(assetFileId('file-service://file-AbC123')).toBe('file-AbC123')
    expect(assetFileId('sediment://file_00000000abcd')).toBe('file_00000000abcd')
    expect(assetFileId('https://evil')).toBeNull()
  })
})

// ------------------------------------------------------------------ inert text

describe('inert chat text', () => {
  it('escaped brackets and hashes are text, not links or tags (graph and preview)', () => {
    const { links, tags } = brainOf('A [\\[Gate]] and \\#portal, but [[Real]] and #real.\n\n| a |\n|---|\n| [[Note\\|alias]] |\n')
    expect(links).toEqual(['Real', 'Note'])
    expect(tags).toEqual(['real'])
    const md = 'x [\\[Gate]] y [[Real]]'
    const processor = unified().use(remarkParse).use(remarkWikilink)
    const tree = processor.runSync(processor.parse(md), md)
    expect(JSON.stringify(tree).match(/"type":"wikilink"/g)).toHaveLength(1)
    // The preview links #tags in text: an escaped hash is set apart so it isn't one.
    const hashes = unified().use(remarkParse).use(remarkLiteralHashes)
    const doc = 'a \\#portal and #real, \\\\#not-escaped'
    const out = JSON.stringify(hashes.runSync(hashes.parse(doc), doc))
    expect(out.match(/"type":"literalHash"/g)).toHaveLength(1)
    expect(out).toContain('"value":"portal and #real, \\\\#not-escaped"')
    // Next to a live link, in the preview's own plugin (the pieces of its split have no position).
    const both = unified().use(remarkParse).use(remarkWikilink)
    const mixed = 'See [[Gate]] and \\#notatag, [\\[Not]]'
    const tree2 = JSON.stringify(both.runSync(both.parse(mixed), mixed))
    expect(tree2.match(/"type":"literalHash"/g)).toHaveLength(1)
    expect(tree2.match(/"type":"wikilink"/g)).toHaveLength(1)
  })

  it('makes links, tags, tasks and swallowing HTML inert, and leaves code alone', () => {
    const chat = [
      'See [[Gate]] and ![[gate.png]] #portal (#lore) C# #1',
      '',
      '- [ ] a task',
      '* [x] done',
      '',
      '```md',
      '- [ ] in code',
      '[[in code]] #incode',
      '```',
      '',
      'Inline `[[code]] #code` stays.',
      '',
      '<!-- never closed',
      '',
      '### Next heading',
      '- [ ] after the comment',
    ].join('\n')
    const out = inertMarkdown(tameChatMarkdown(chat))
    const { links, tags, tasks } = brainOf(out)
    expect(links).toEqual([])
    expect(tags).toEqual([])
    expect(tasks).toEqual([])
    expect(out).toContain('```md\n- [ ] in code\n[[in code]] #incode\n```')
    expect(out).toContain('Inline `[[code]] #code` stays.')
    expect(out).toContain('C# #1')
    // Idempotent: inert text stays as it is.
    expect(inertMarkdown(out)).toBe(out)
  })

  it('keeps every message whole: nothing it opens (fence, HTML, list) reaches the next one or the notes after it', () => {
    const conv = {
      source: 'claude' as const, id: 'q', title: 'Q', created: '2026-03-02T10:00:00Z', updated: '2026-03-02T10:00:00Z',
      url: 'https://claude.ai/chat/qqqqqq', projectId: null, gptId: null, model: null,
      messages: [
        { role: 'assistant' as const, time: null, text: '1. Install the deps:\n   ```bash\n   npm i', attachments: [], images: [], artifacts: [] },
        { role: 'user' as const, time: null, text: `${'<!--\n'.repeat(60)}<div>\n\`\`\`\n\n\`\`\`\n- [ ] LIVE TASK`, attachments: [], images: [], artifacts: [] },
        { role: 'assistant' as const, time: null, text: 'Last one', attachments: [], images: [], artifacts: [] },
      ],
    }
    const note = `${renderChatNote(conv, '2026-03-02 Q', { utc: true })}\n## After\n\nSee [[Idea]] #followup\n\n- [ ] mine\n`
    const tree = parseMarkdown(splitFrontmatter(note).body)
    const headings = tree.children.filter((n) => n.type === 'heading').map((n) => JSON.stringify(n).match(/"value":"([^"]+)"/)?.[1])
    expect(headings).toEqual(['2026-03-02 Q', 'Transcript', 'Claude', 'You', 'Claude', 'After'])
    const { links, tags, tasks } = brainOf(note)
    expect(links).toEqual(['Idea'])
    expect(tags).toEqual(['ai-chat', 'claude', 'followup'])
    expect(tasks).toEqual(['mine'])
    // Text above the transcript that toggles the line-by-line task scan changes nothing inside it.
    const toggled = note.replace('## Transcript', '```\n\n## Transcript')
    expect(brainOf(toggled).tasks.filter((t) => t !== 'mine')).toEqual([])
  })

  it('escapes a link inside a markdown link without breaking the link around it', () => {
    for (const text of ['[a [[x]] b](u[[y]])', '[a [[x]] b](#tag)', '[a [[x]] b](u "[[y]] #z")', '<!-- TODO --> and `#include` stays', 'if [[ -f x ]]; then #comment']) {
      const conv = { source: 'claude' as const, id: 'l', title: 'L', created: null, updated: null, url: 'https://claude.ai/chat/llllll', projectId: null, gptId: null, model: null, messages: [{ role: 'user' as const, time: null, text, attachments: [], images: [], artifacts: [] }] }
      const b = brainOf(renderChatNote(conv, 'L', { utc: true }))
      expect(b.links, text).toEqual([])
      expect(b.tags, text).toEqual(['ai-chat', 'claude'])
    }
    // Both sides escaped: the markdown link around stays a link (no fail-closed escape was needed).
    const nested = { source: 'claude' as const, id: 'n', title: 'N', created: null, updated: null, url: 'https://claude.ai/chat/nnnnnn', projectId: null, gptId: null, model: null, messages: [{ role: 'user' as const, time: null, text: '[a [[x]] b](u[[y]])', attachments: [], images: [], artifacts: [] }] }
    expect(renderChatNote(nested, 'N', { utc: true })).toContain('> [a \\[\\[x\\]\\] b](u[[y]])')
    // Code is never touched outside the fail-closed path.
    const code = { source: 'claude' as const, id: 'c', title: 'C', created: null, updated: null, url: 'https://claude.ai/chat/cccccc', projectId: null, gptId: null, model: null, messages: [{ role: 'user' as const, time: null, text: 'Mark it <!-- TODO --> please\n\n```c\n#include <stdio.h>\nif [[ -f x ]]\n```\n\n    - [ ] indented code', attachments: [], images: [], artifacts: [] }] }
    const out = renderChatNote(code, 'C', { utc: true })
    expect(out).toContain('> #include <stdio.h>\n> if [[ -f x ]]')
    expect(out).toContain('>     - [ ] indented code')
    // The fail-closed escape leaves nothing live, in code too.
    const blank = blanketInert('[[a]] #b\n- [ ] c\n```\n[[d]] #e\n```')
    expect(brainOf(blank).links).toEqual([])
    expect(brainOf(blank).tags).toEqual([])
    expect(brainOf(blank).tasks).toEqual([])
  })

  it('pathological emphasis runs cost milliseconds, in chats and in any note', () => {
    let t = performance.now()
    const tamed = tameChatMarkdown(`${'*a'.repeat(20000)}\n\nnormal *emphasis* stays`)
    parseMarkdown(tamed)
    expect(performance.now() - t).toBeLessThan(2000)
    expect(tamed).toMatch(/^~~~text\n\*a\*a/)
    // A tilde run inside cannot close the block early.
    const tildes = tameChatMarkdown(`${'*a'.repeat(1200)} ~~~~~\n[[x]] #y`)
    expect(tildes.startsWith('~~~~~~text\n')).toBe(true)
    expect(brainOf(tildes).links).toEqual([])
    expect(tamed).toContain('normal *emphasis* stays')
    // The brain's own parser guards every note the same way (same length: offsets stay true).
    t = performance.now()
    const note = parseNote({ path: 'x.md', content: `# X\n\n${'**_'.repeat(20000)}\n\nSee [[Real]] #tag\n` })
    expect(performance.now() - t).toBeLessThan(2000)
    expect(note.links.map((l) => l.to)).toEqual(['Real'])
    expect(note.meta.tags).toEqual(['tag'])
  })

  it('closes fences a message left open', () => {
    expect(closeFences('```js\ncode')).toBe('```js\ncode\n```')
    expect(closeFences('~~~~\nx\n~~~')).toBe('~~~~\nx\n~~~\n~~~~')
    expect(closeFences('```\nx\n```')).toBe('```\nx\n```')
  })
})

// ------------------------------------------------------------------ notes and plans

describe('chat notes', () => {
  it('writes a chat as a plain note: standard frontmatter, source line, inert transcript, embeds', () => {
    const c = archive().conversations.find((x) => x.id === 'c-1')!
    const content = renderChatNote(c, '2026-03-02 Portal lighting', { utc: true, projectLink: 'PORTALz (Claude project)' })
    const { frontmatter } = splitFrontmatter(content)
    expect(Object.keys(frontmatter).sort()).toEqual(['created', 'tags', 'title', 'updated'])
    expect(frontmatter).toMatchObject({ title: '2026-03-02 Portal lighting', tags: ['ai-chat', 'claude'], created: '2026-03-02', updated: '2026-03-04' })
    expect(content).toContain('Claude chat in [[PORTALz (Claude project)]]')
    expect(content).toContain('Source: <https://claude.ai/chat/c-1>')
    expect(content).toContain('*3 messages · 2026-03-02 → 2026-03-04*')
    expect(content).toContain('### You · 2026-03-02 14:05')
    expect(content).toContain('### Claude · 14:07')
    expect(content).toContain('### You · 2026-03-04 09:00')
    expect(content).toContain('> **🧩 Glow shader**')
    expect(content).toContain('> ````python\n> glow = 1  # [[not a link]]\n> ```\n> nested\n> ```\n> ````')
    const { links, tags, tasks } = brainOf(content)
    expect(links).toEqual(['PORTALz (Claude project)'])
    expect(tags).toEqual(['ai-chat', 'claude'])
    expect(tasks).toEqual([])
  })

  it('plans a whole import: folders, numbered names, hubs, knowledge, Aether project match, pictures', () => {
    const plan = planChatImport(archive(), [], {
      base: 'Resources/AI Chats',
      utc: true,
      pictureFiles: ['file-AbC123-monolith.webp', 'user-x/file_999-other.png'],
      projects: [{ title: 'Other', home: 'Projects/Other' }],
    })
    const paths = plan.create.map((p) => p.path).sort()
    expect(paths).toEqual([
      'Resources/AI Chats/ChatGPT/Project abcdef12/2026-03-04 Monolith ideas.md',
      'Resources/AI Chats/Claude/2026-03-02 New chat about monoliths.md',
      'Resources/AI Chats/Claude/2026-03-02 Portal lighting.md',
      'Resources/AI Chats/Claude/PORTALz/2026-03-02 Portal lighting 2.md',
      'Resources/AI Chats/Claude/PORTALz/Knowledge/PORTALz – gen.md',
      'Resources/AI Chats/Claude/PORTALz/Knowledge/PORTALz – lore bible.md',
      'Resources/AI Chats/Claude/PORTALz/PORTALz (Claude project).md',
    ])
    expect(plan.pictures).toEqual([{ from: 'file-AbC123-monolith.webp', path: 'Resources/AI Chats/ChatGPT/Project abcdef12/Pictures/2026-03-04 Monolith ideas 1.webp' }])
    expect(plan.counts).toMatchObject({ claude: 3, chatgpt: 1, projects: 1, docs: 2, pictures: 1 })
    const gpt = plan.create.find((p) => p.path.includes('Monolith'))!.content
    expect(gpt).toContain('![[2026-03-04 Monolith ideas 1.webp]]')
    expect(gpt).toContain('ChatGPT project: <https://chatgpt.com/g/g-p-abcdef1234567890/project>')
    const hub = plan.create.find((p) => p.kind === 'project')!.content
    expect(hub).toContain('- [[PORTALz – lore bible]]')
    // Two chats named alike on one day get different titles: a link finds the right one.
    expect(hub).toContain('- [[2026-03-02 Portal lighting 2]]')
    expect(new Set(plan.create.map((p) => String(splitFrontmatter(p.content).frontmatter.title).toLowerCase())).size).toBe(plan.create.length)
    expect(brainOf(hub).tags).toEqual(['ai-project', 'claude'])
    const lore = plan.create.find((p) => p.path.endsWith('lore bible.md'))!.content
    expect(brainOf(lore).tasks).toEqual([])
    expect(brainOf(lore).links).toEqual(['PORTALz (Claude project)'])
    expect(plan.create.find((p) => p.path.endsWith('gen.md'))!.content).toContain('> ```python\n> print("hi")\n> ```')
    // Every note the plan writes gives the brain no stray links, tags or tasks.
    for (const p of plan.create) {
      const b = brainOf(p.content, p.path)
      expect(b.tasks, p.path).toEqual([])
      expect(b.tags.every((t) => ['ai-chat', 'ai-project', 'ai-knowledge', 'claude', 'chatgpt'].includes(t)), p.path).toBe(true)
    }
  })

  it('files a project with the name of an Aether project into that project', () => {
    const plan = planChatImport(archive(), [], { base: 'AI Chats', utc: true, projects: [{ title: 'portalz', home: 'Projects/PORTALz' }] })
    expect(plan.create.find((p) => p.kind === 'project')!.path).toBe('Projects/PORTALz/AI Chats/PORTALz (Claude project).md')
    const chat = plan.create.find((p) => p.path === 'Projects/PORTALz/AI Chats/2026-03-02 Portal lighting 2.md')!
    expect(chat.content).toContain('Project: [[portalz]]')
  })

  it('re-importing changes nothing, a grown chat rewrites only its transcript, moved notes are found', () => {
    const first = planChatImport(archive(), [], { base: 'AI Chats', utc: true })
    // The user moves one chat and writes above its transcript.
    const notes = first.create.map((p) => {
      if (!p.path.endsWith('Claude/2026-03-02 Portal lighting.md')) return parseNote({ path: p.path, content: p.content })
      const edited = p.content.replace(TRANSCRIPT_HEADING, `My thoughts: rim light wins.\n\n${TRANSCRIPT_HEADING}`)
      return parseNote({ path: 'Projects/PORTALz/Portal lighting chat.md', content: edited })
    })
    const again = planChatImport(archive(), notes, { base: 'AI Chats', utc: true })
    expect(again.create).toEqual([])
    expect(again.update).toEqual([])
    expect(again.unchanged).toBe(4)

    const grown = archive()
    const c = grown.conversations.find((x) => x.id === 'c-1') as ChatConversation
    c.messages.push({ role: 'assistant', time: '2026-03-05T10:00:00Z', text: 'One more idea.', attachments: [], images: [], artifacts: [] })
    const plan = planChatImport(grown, notes, { base: 'AI Chats', utc: true })
    expect(plan.create).toEqual([])
    const u = plan.update.find((x) => x.kind === 'chat')!
    expect(u.path).toBe('Projects/PORTALz/Portal lighting chat.md')
    const moved = notes.find((n) => n.meta.path === u.path)!
    const next = applyChatUpdate(moved.raw, u)!
    expect(next).toContain('My thoughts: rim light wins.')
    expect(next).toContain('One more idea.')
    expect(sectionOf(next, TRANSCRIPT_HEADING)).toContain('*4 messages')
    // The hub lists its chats: unchanged, so not rewritten.
    expect(plan.update.filter((x) => x.kind === 'project')).toEqual([])
  })

  it('knows a note only by the Source line in its header, and rewrites only chat notes', () => {
    const first = planChatImport(archive(), [], { base: 'AI Chats', utc: true })
    const chatPath = 'AI Chats/Claude/2026-03-02 Portal lighting.md'
    const chat = first.create.find((p) => p.path === chatPath)!
    // A chat quoting another chat's address in its transcript or summary does not become that chat.
    const quoting = chat.content.replace('Use rim light.', 'Use rim light.\n\nSource: <https://claude.ai/chat/c-2>')
    const notes = [parseNote({ path: chatPath, content: quoting })]
    expect(importedNotes(notes).get('https://claude.ai/chat/c-2')).toBeUndefined()
    // A note of the user's carrying a chat's address is never rewritten (nor duplicated).
    const mine = parseNote({ path: 'Areas/Meeting.md', content: '# Meeting\n\nSource: <https://claude.ai/chat/c-1>\n\n## Transcript\n\n*1 message*\n\n## My follow-ups\n\n- [ ] call Sam\n' })
    const plan = planChatImport(archive(), [mine], { base: 'AI Chats', utc: true })
    // ...and never blocks the chat either: the chat gets a note of its own.
    expect(plan.update).toEqual([])
    expect(plan.create.map((p) => p.path)).toContain('AI Chats/Claude/2026-03-02 Portal lighting.md')
    expect(plan.unchanged).toBe(0)
  })

  it('keeps what follows the end of the transcript, and a summary never moves where the transcript starts', () => {
    const c = archive().conversations.find((x) => x.id === 'c-1')!
    const note = renderChatNote(c, '2026-03-02 Portal lighting', { utc: true })
    expect(note.trimEnd().endsWith(TRANSCRIPT_END)).toBe(true)
    const withFollowUp = `${note}\n## Follow-up\n\n- [ ] try fog cards\n`
    const grown = { ...c, messages: [...c.messages, { role: 'user' as const, time: null, text: 'more', attachments: [], images: [], artifacts: [] }] }
    const next = applyChatUpdate(withFollowUp, { heading: TRANSCRIPT_HEADING, section: renderTranscript(grown, { utc: true }), updated: null })!
    expect(next).toContain('## Follow-up\n\n- [ ] try fog cards')
    expect(next.match(new RegExp(TRANSCRIPT_END.replace(/[*]/g, '\\*'), 'g'))).toHaveLength(1)
    expect(sectionOf(next, TRANSCRIPT_HEADING, TRANSCRIPT_END)).toContain('*4 messages')
    // A summary's own "## Transcript" heading is pushed down: the real one stays the first.
    const summarized = replaceSummary(next, '## Transcript\n\n- [ ] keep me')!
    expect(summarized).toContain('#### Transcript\n\n- [ ] keep me')
    expect(sectionOf(summarized, TRANSCRIPT_HEADING, TRANSCRIPT_END)).toContain('*4 messages')
  })

  it('spells a chat address one way', () => {
    expect(chatUrlOf('https://chat.openai.com/c/6650aa11-bb22')).toBe('https://chatgpt.com/c/6650aa11-bb22')
    expect(chatUrlOf('https://www.chatgpt.com/g/g-p-abc123-portal/c/6650aa11-bb22/?model=x')).toBe('https://chatgpt.com/c/6650aa11-bb22')
    expect(chatUrlOf('https://claude.ai/chat/5a1f0c1e-1111#top')).toBe('https://claude.ai/chat/5a1f0c1e-1111')
    expect(chatUrlOf('https://evil.example/c/6650aa11')).toBeNull()
    expect(chatUrlOf('https://claude.ai/chat/../x')).toBeNull()
  })

  it('never takes a path twice and never collides with a note in the vault', () => {
    const vault = [parseNote({ path: 'AI Chats/Claude/2026-03-02 Portal lighting.md', content: '# mine' })]
    const plan = planChatImport(archive(), vault, { base: 'AI Chats', utc: true })
    const paths = plan.create.map((p) => p.path.toLowerCase())
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toContain('ai chats/claude/2026-03-02 portal lighting 2.md')
    const note = plan.create.find((p) => p.path.endsWith('Portal lighting 2.md'))!
    expect(splitFrontmatter(note.content).frontmatter.title).toBe('2026-03-02 Portal lighting 2')
  })
})

describe('chat import: review round two', () => {
  const conv = (over: Partial<ChatConversation>, text = 'hi'): ChatConversation => ({
    source: 'claude', id: 'x1', title: 'T', created: '2026-01-01T10:00:00Z', updated: '2026-01-01T10:00:00Z', url: 'https://claude.ai/chat/x1x1x1', projectId: null, gptId: null, model: null,
    messages: [{ role: 'user', time: null, text, attachments: [], images: [], artifacts: [] }],
    ...over,
  })

  it('escapes in one pass: thousands of tags and links cost milliseconds', () => {
    const big = Array.from({ length: 10 }, () => conv({}, '#a [[b]] '.repeat(15000)).messages[0]!)
    const t = performance.now()
    const out = renderTranscript(conv({ messages: big }), { utc: true })
    expect(performance.now() - t).toBeLessThan(8000)
    expect(brainOf(`# x\n\n${out}`).tags).toEqual([])
  })

  it('keeps code as written: no blank lines squeezed out of a Python file', () => {
    const out = renderTranscript(conv({}, '```python\ndef a():\n    pass\n\n\ndef b():\n    pass\n```'), { utc: true })
    expect(out).toContain('>     pass\n>\n>\n> def b():')
  })

  it('a hub keeps what the user wrote after it, and a projects.json alone keeps its list of chats', () => {
    const first = planChatImport(archive(), [], { base: 'AI Chats', utc: true })
    const notes = first.create.map((p) => parseNote({ path: p.path, content: p.kind === 'project' ? `${p.content}\n## My thoughts\n\nKeep this!\n` : p.content }))
    const hub = notes.find((n) => n.meta.tags.includes('ai-project'))!
    const changed = readChatExport([{ name: 'projects.json', text: JSON.stringify([{ ...claudeProjects[0], description: 'The portal game, v2.' }]) }])
    const plan = planChatImport(changed, notes, { base: 'AI Chats', utc: true })
    const u = plan.update.find((x) => x.kind === 'project')!
    const next = applyChatUpdate(hub.raw, u)!
    expect(next).toContain('The portal game, v2.')
    expect(next).toContain('## My thoughts\n\nKeep this!')
    expect(next).toContain('- [[2026-03-02 Portal lighting 2]]')
    expect(plan.create).toEqual([])
  })

  it('knowledge docs: unique titles, one per project and file, found again after the hub moved', () => {
    const long = 'My long project about the portal game very long indeed'
    const two = readChatExport([
      { name: 'projects.json', text: JSON.stringify([
        { uuid: 'pa', name: long, prompt_template: '', docs: [{ filename: 'notes.md', content: 'FIRST' }] },
        { uuid: 'pb', name: `${long} too`, prompt_template: '', docs: [{ filename: 'notes.md', content: 'SECOND' }] },
        { uuid: 'pc', name: 'Portal', prompt_template: '', docs: [{ filename: 'notes.md', content: 'THIRD' }] },
        { uuid: 'pd', name: 'Portal', prompt_template: '', docs: [{ filename: 'notes.md', content: 'FOURTH' }] },
      ]) },
    ])
    const plan = planChatImport(two, [], { base: 'AI', utc: true })
    const docs = plan.create.filter((p) => p.kind === 'doc')
    expect(docs).toHaveLength(4)
    const titles = docs.map((d) => String(splitFrontmatter(d.content).frontmatter.title))
    expect(new Set(titles).size).toBe(4)
    for (const text of ['FIRST', 'SECOND', 'THIRD', 'FOURTH']) expect(docs.some((d) => d.content.includes(`> ${text}`))).toBe(true)
    // The hub and its docs moved elsewhere: a re-import finds them, nothing is made twice.
    const moved = plan.create.map((p) => parseNote({ path: p.path.replace(/^AI\//, 'Projects/Moved/'), content: p.content }))
    expect(planChatImport(two, moved, { base: 'AI', utc: true }).create).toEqual([])
  })

  it('a moved chat with pictures: its pictures are not copied again, its transcript not rewritten', () => {
    const first = planChatImport(archive(), [], { base: 'AI', utc: true, pictureFiles: ['file-AbC123-monolith.webp'] })
    const pics = first.pictures.map((p) => p.path.replace(/^AI\//, 'Elsewhere/'))
    const notes = first.create.map((p) => parseNote({ path: p.path.replace(/^AI\/ChatGPT\//, 'Elsewhere/'), content: p.content }))
    const again = planChatImport(archive(), notes, { base: 'AI', utc: true, pictureFiles: ['file-AbC123-monolith.webp'], existingPictures: pics })
    expect(again.pictures).toEqual([])
    expect(again.update).toEqual([])
  })

  it('names: never half an emoji, never over 255 bytes, never a folder from an id', () => {
    const emoji = `${'a'.repeat(118)}😀😀`
    const c1 = conv({ title: emoji })
    const cjk = conv({ id: 'x2', url: 'https://claude.ai/chat/x2x2x2', title: '漢'.repeat(200) })
    const gpt = conv({ source: 'chatgpt', id: 'g9', url: 'https://chatgpt.com/c/g9g9g9', projectId: 'g-p-../../..:*?<>|', title: 'G' })
    const odd = readChatExport([{ name: 'conversations.json', text: `[{"uuid":"\\ud800bad","name":"x","chat_messages":[{"uuid":"m","sender":"human","text":"hi"}]}]` }])
    const plan = planChatImport({ conversations: [c1, cjk, cjk, gpt, ...odd.conversations], projects: [], files: [], warnings: [] }, [], { base: 'AI', utc: true })
    for (const p of plan.create) {
      const name = p.path.slice(p.path.lastIndexOf('/') + 1)
      expect(new TextEncoder().encode(name).length, name).toBeLessThanOrEqual(200)
      expect(/[\ud800-\udfff]/.test(name.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), name).toBe(false)
      expect(p.path.split('/').every((seg) => seg !== '..' && !/[:*?<>|]/.test(seg)), p.path).toBe(true)
    }
    expect(plan.create.some((p) => p.path.startsWith('AI/ChatGPT/Project '))).toBe(true)
  })

  it('reads the thread of a Claude chat whose current leaf is missing, and keeps the newer copy of a chat found twice', () => {
    const branched = [{ uuid: 'b1', name: 'B', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', current_leaf_message_uuid: 'gone', chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'q', created_at: '2026-01-01T00:00:00Z', parent_message_uuid: '00000000-0000-4000-8000-000000000000' },
      { uuid: 'm2', sender: 'assistant', text: 'old answer', created_at: '2026-01-01T00:01:00Z', parent_message_uuid: 'm1' },
      { uuid: 'm3', sender: 'assistant', text: 'new answer', created_at: '2026-01-01T00:02:00Z', parent_message_uuid: 'm1' },
    ] }]
    const newer = [{ ...branched[0], updated_at: '2026-02-01T00:00:00Z', name: 'B newer' }]
    const a = readChatExport([{ name: 'a/conversations.json', text: JSON.stringify(branched) }, { name: 'b/conversations.json', text: JSON.stringify(newer) }])
    expect(a.conversations).toHaveLength(1)
    expect(a.conversations[0]!.title).toBe('B newer')
    expect(a.conversations[0]!.messages.map((m) => m.text)).toEqual(['q', 'new answer'])
  })

  it('zip: a comment holding the end signature, and a stored entry bigger than it claims', async () => {
    const zip = makeZip({ 'conversations.json': '[]' }, { store: true })
    const comment = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(30).fill(0)])
    const withComment = new Uint8Array(zip.length + comment.length)
    withComment.set(zip)
    withComment.set(comment, zip.length)
    // The comment length field of the real end record.
    withComment[zip.length - 2] = comment.length & 0xff
    withComment[zip.length - 1] = comment.length >> 8
    expect((await zipEntries(bytesZipSource(withComment))).map((e) => e.name)).toEqual(['conversations.json'])
    const stored = makeZip({ 'big.json': 'x'.repeat(20000) }, { store: true })
    const src = bytesZipSource(stored)
    const [e] = await zipEntries(src)
    await expect(zipRead(src, { ...e!, size: 10 }, 1000)).rejects.toThrow(/too large/)
  })

  it('ordinary notes read as before: quotes without a space, character references', () => {
    expect(brainOf('>quote line\n>#bar\n\n>>#deep').tags).toEqual(['bar', 'deep'])
    expect(brainOf('[[Caf&eacute;]] and [[AT&amp;T]]').links).toEqual(['Café', 'AT&T'])
    expect(brainOf('#caf&eacute; a&nbsp;#nbsp').tags).toEqual(['café', 'nbsp'])
    expect(brainOf('&#91;[x]] \\#no').links).toEqual([])
    expect(brainOf(`${'x_'.repeat(1200)} [[my_other_note]]`).links.map((l) => l)).toEqual(['my_other_note'])
  })
})

