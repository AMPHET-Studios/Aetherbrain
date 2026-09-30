/**
 * Claude and ChatGPT data exports, read into one plain shape.
 *
 * Claude (Settings → Privacy → Export data) sends a zip with
 * `conversations.json` (every chat, messages in order, attachment text
 * inline), `projects.json` or `projects/<name>.json` (instructions and
 * knowledge docs), `users.json` and `memories.json`. ChatGPT (Settings → Data
 * controls → Export) sends `conversations.json`, where each chat is a tree of
 * messages (edits and regenerations are branches; the visible thread runs
 * from `current_node` up to the root), plus the pictures of the chats.
 *
 * Both formats change without notice, so every field is read defensively:
 * anything missing or of the wrong type is skipped, never thrown on.
 */

export type ChatSource = 'claude' | 'chatgpt'

export interface ChatAttachment {
  name: string
  /** Text the service extracted from the file (Claude), if any. */
  text?: string
}

/** A picture in a chat (ChatGPT only: Claude exports carry no picture files). */
export interface ChatImage {
  /** File id from the asset pointer (`file-AbC…`, `file_0000…`): the start of the picture's file name in the export. */
  fileId: string
  /** Prompt of a generated picture, if known. */
  prompt?: string
}

/** Something the assistant made on a canvas: a Claude artifact or a ChatGPT canvas document. */
export interface ChatArtifact {
  title: string
  /** Fence language (`python`, `html`, `markdown` …), '' when unknown. */
  language: string
  content: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  /** ISO time, or null when the export has none. */
  time: string | null
  /** Markdown as written in the chat. */
  text: string
  attachments: ChatAttachment[]
  images: ChatImage[]
  artifacts: ChatArtifact[]
}

export interface ChatConversation {
  source: ChatSource
  id: string
  title: string
  created: string | null
  updated: string | null
  /** Where the chat lives online (also the note's identity on re-import). */
  url: string
  /** Project (Claude project uuid, ChatGPT `g-p-…` id), or null. */
  projectId: string | null
  /** Custom GPT (ChatGPT `g-…` id) the chat was with, or null. */
  gptId: string | null
  model: string | null
  messages: ChatMessage[]
}

export interface ChatProjectDoc {
  name: string
  content: string
}

export interface ChatProject {
  source: ChatSource
  id: string
  name: string
  description: string
  /** Custom instructions of the project. */
  instructions: string
  docs: ChatProjectDoc[]
  created: string | null
  updated: string | null
  url: string
}

export interface ChatArchive {
  conversations: ChatConversation[]
  projects: ChatProject[]
  /** Files that were read (for the summary). */
  files: string[]
  /** Files skipped or not understood, with the reason. */
  warnings: string[]
}

export interface ExportFile {
  /** Path of the file (inside the zip, or the file name of a loose .json). */
  name: string
  text: string
}

/** Files of an export worth reading: the JSON of chats and projects (not users.json, memories.json …). */
export function isChatExportJson(name: string): boolean {
  const n = name.replace(/\\/g, '/').toLowerCase()
  if (!n.endsWith('.json') || n.split('/').some((s) => s.startsWith('.') || s === '__macosx')) return false
  const base = n.slice(n.lastIndexOf('/') + 1)
  if (/^conversations([-_.]?\d+)?\.json$/.test(base) || base === 'projects.json') return true
  // Newer Claude exports: one file per project under projects/.
  return /(^|\/)projects\/[^/]+\.json$/.test(n)
}

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** An ISO time from an ISO string or unix seconds, else null. */
function isoOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v * 1000)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  return null
}

/** A title on one line. */
function titleOf(...candidates: unknown[]): string {
  for (const c of candidates) {
    const t = str(c).replace(/\s+/g, ' ').trim()
    if (t) return t.length > 160 ? `${t.slice(0, 157)}…` : t
  }
  return ''
}

/** Read every file of an export (see `isChatExportJson`); anything not understood becomes a warning. */
export function readChatExport(files: ExportFile[]): ChatArchive {
  const out: ChatArchive = { conversations: [], projects: [], files: [], warnings: [] }
  const seenConv = new Set<string>()
  const seenProj = new Set<string>()
  for (const f of files) {
    let data: unknown
    try {
      data = JSON.parse(f.text.startsWith('\uFEFF') ? f.text.slice(1) : f.text)
    } catch {
      out.warnings.push(`${f.name}: not valid JSON`)
      continue
    }
    const before = out.conversations.length + out.projects.length
    collect(data, out, seenConv, seenProj, 0)
    if (out.conversations.length + out.projects.length > before) out.files.push(f.name)
    else out.warnings.push(`${f.name}: no chats or projects found`)
  }
  return out
}

function collect(data: unknown, out: ChatArchive, seenConv: Set<string>, seenProj: Set<string>, depth: number): void {
  if (depth > 2) return
  if (Array.isArray(data)) {
    for (const item of data) collectOne(item, out, seenConv, seenProj)
    return
  }
  if (!isRec(data)) return
  // `{ conversations: [...] }`, `{ projects: [...] }`, or one object.
  let wrapped = false
  for (const key of ['conversations', 'projects', 'data', 'items']) {
    if (Array.isArray(data[key])) {
      wrapped = true
      collect(data[key], out, seenConv, seenProj, depth + 1)
    }
  }
  if (!wrapped) collectOne(data, out, seenConv, seenProj)
}

function collectOne(item: unknown, out: ChatArchive, seenConv: Set<string>, seenProj: Set<string>): void {
  if (!isRec(item)) return
  let conv: ChatConversation | null = null
  let proj: ChatProject | null = null
  if (Array.isArray(item.chat_messages)) conv = claudeConversation(item)
  else if (isRec(item.mapping)) conv = chatgptConversation(item)
  else if ('prompt_template' in item || Array.isArray(item.docs)) proj = claudeProject(item)
  if (conv && !seenConv.has(conv.url)) {
    seenConv.add(conv.url)
    out.conversations.push(conv)
  }
  if (proj && !seenProj.has(proj.url)) {
    seenProj.add(proj.url)
    out.projects.push(proj)
  }
}

// ---------------------------------------------------------------- Claude

/** Fence language of a Claude artifact type. */
function artifactLanguage(type: string, language: string): string {
  if (language) return language.toLowerCase().replace(/[^a-z0-9+#-]/g, '')
  const t = type.toLowerCase()
  if (t.includes('markdown')) return 'markdown'
  if (t.includes('html')) return 'html'
  if (t.includes('svg')) return 'svg'
  if (t.includes('react')) return 'jsx'
  if (t.includes('mermaid')) return 'mermaid'
  return ''
}

function claudeMessage(m: Rec): ChatMessage | null {
  const sender = str(m.sender)
  const role = sender === 'human' || sender === 'user' ? 'user' : sender === 'assistant' ? 'assistant' : null
  if (!role) return null
  const texts: string[] = []
  const artifacts: ChatArtifact[] = []
  for (const b of arr(m.content)) {
    if (!isRec(b)) continue
    const type = str(b.type)
    if ((type === 'text' || type === 'voice_note') && str(b.text).trim()) texts.push(str(b.text))
    else if (type === 'tool_use' && isRec(b.input) && (str(b.name) === 'artifacts' || str(b.name) === 'create_file')) {
      const input = b.input
      const command = str(input.command)
      const content = str(input.content) || str(input.file_text)
      if (content && (command === '' || command === 'create' || command === 'rewrite')) {
        artifacts.push({
          title: titleOf(input.title, input.path, input.id) || 'Artifact',
          language: artifactLanguage(str(input.type), str(input.language)),
          content,
        })
      }
    }
  }
  if (!texts.length && str(m.text).trim()) texts.push(str(m.text))
  const attachments: ChatAttachment[] = []
  for (const a of arr(m.attachments)) {
    if (!isRec(a)) continue
    const name = titleOf(a.file_name, a.name) || 'attachment'
    const text = str(a.extracted_content) || str(a.content)
    attachments.push(text.trim() ? { name, text } : { name })
  }
  for (const f of [...arr(m.files), ...arr(m.files_v2)]) {
    if (!isRec(f)) continue
    const name = titleOf(f.file_name, f.name)
    if (name && !attachments.some((a) => a.name === name)) attachments.push({ name })
  }
  const text = texts.join('\n\n').trim()
  if (!text && !attachments.length && !artifacts.length) return null
  return { role, time: isoOf(m.created_at), text, attachments, images: [], artifacts }
}

function claudeConversation(c: Rec): ChatConversation | null {
  const id = str(c.uuid) || str(c.id)
  if (!id) return null
  const raw = arr(c.chat_messages).filter(isRec)
  let ordered = raw
  const leaf = str(c.current_leaf_message_uuid)
  if (leaf && raw.some((m) => str(m.parent_message_uuid))) {
    // Edited messages are branches: the thread shown is the leaf's line to the root.
    const byId = new Map(raw.map((m) => [str(m.uuid), m]))
    const chain: Rec[] = []
    const seen = new Set<string>()
    for (let m = byId.get(leaf); m && !seen.has(str(m.uuid)); m = byId.get(str(m.parent_message_uuid))) {
      seen.add(str(m.uuid))
      chain.push(m)
    }
    if (chain.length) ordered = chain.reverse()
  } else if (raw.every((m) => typeof m.index === 'number')) {
    ordered = [...raw].sort((a, b) => (a.index as number) - (b.index as number))
  }
  const messages = mergeTurns(ordered.map(claudeMessage).filter((m): m is ChatMessage => m !== null))
  const project = isRec(c.project) ? c.project : null
  return {
    source: 'claude',
    id,
    title: titleOf(c.name, c.summary, messages.find((m) => m.role === 'user')?.text) || 'Untitled chat',
    created: isoOf(c.created_at),
    updated: isoOf(c.updated_at) ?? isoOf(c.created_at),
    url: `https://claude.ai/chat/${encodeURIComponent(id)}`,
    projectId: str(c.project_uuid) || (project ? str(project.uuid) : '') || null,
    gptId: null,
    model: str(c.model) || null,
    messages,
  }
}

function claudeProject(p: Rec): ChatProject | null {
  const id = str(p.uuid) || str(p.id)
  if (!id || p.is_starter_project === true) return null
  const docs: ChatProjectDoc[] = []
  const names = new Set<string>()
  for (const d of arr(p.docs)) {
    if (!isRec(d)) continue
    const content = str(d.content)
    const name = titleOf(d.filename, d.file_name, d.name) || 'Document'
    if (!content.trim() || names.has(name.toLowerCase())) continue
    names.add(name.toLowerCase())
    docs.push({ name, content })
  }
  return {
    source: 'claude',
    id,
    name: titleOf(p.name, p.title) || 'Untitled project',
    description: str(p.description).trim(),
    instructions: str(p.prompt_template).trim(),
    docs,
    created: isoOf(p.created_at),
    updated: isoOf(p.updated_at) ?? isoOf(p.created_at),
    url: `https://claude.ai/project/${encodeURIComponent(id)}`,
  }
}

// ---------------------------------------------------------------- ChatGPT

/** Citation markers ChatGPT leaves in exported text (`【12†source】`, private-use `\ue200cite…\ue201`). */
function stripCitations(text: string): string {
  return text
    .replace(/【\d+(?::\d+)?†[^【】\n]{0,200}】/g, '')
    .replace(/\ue200[^\ue201\n]{0,400}\ue201/g, '')
    .replace(/[\ue200-\ue206]/g, '')
}

/** File id of an asset pointer: `file-service://file-AbC` → `file-AbC`, `sediment://file_00ab` → `file_00ab`. */
export function assetFileId(pointer: string): string | null {
  const m = /^[a-z-]+:\/\/(file[-_][A-Za-z0-9]+)/.exec(pointer)
  return m?.[1] ?? null
}

interface Piece {
  role: 'user' | 'assistant'
  time: string | null
  text: string
  attachments: ChatAttachment[]
  images: ChatImage[]
  artifacts: ChatArtifact[]
}

function imagesOfParts(parts: unknown[]): ChatImage[] {
  const out: ChatImage[] = []
  for (const p of parts) {
    if (!isRec(p) || str(p.content_type) !== 'image_asset_pointer') continue
    const fileId = assetFileId(str(p.asset_pointer))
    if (!fileId) continue
    const dalle = isRec(p.metadata) && isRec(p.metadata.dalle) ? p.metadata.dalle : null
    const prompt = dalle ? str(dalle.prompt).trim() : ''
    out.push(prompt ? { fileId, prompt } : { fileId })
  }
  return out
}

function chatgptPiece(msg: Rec): Piece | null {
  const author = isRec(msg.author) ? msg.author : {}
  const role = str(author.role)
  const meta = isRec(msg.metadata) ? msg.metadata : {}
  if (role === 'system' || meta.is_visually_hidden_from_conversation === true || meta.is_user_system_message === true) return null
  const content = isRec(msg.content) ? msg.content : {}
  const type = str(content.content_type)
  const parts = arr(content.parts)
  const recipient = str(msg.recipient) || 'all'
  const time = isoOf(msg.create_time)
  const empty: Piece = { role: 'assistant', time, text: '', attachments: [], images: [], artifacts: [] }

  if (role === 'tool') {
    // Generated pictures come back as tool messages.
    const images = imagesOfParts(parts)
    return images.length ? { ...empty, images } : null
  }
  if (role !== 'user' && role !== 'assistant') return null

  if (recipient !== 'all') {
    if (role !== 'assistant') return null
    const raw = str(content.text) || parts.filter((p) => typeof p === 'string').join('')
    let call: unknown = null
    try {
      call = JSON.parse(raw)
    } catch {
      return null
    }
    if (!isRec(call)) return null
    if (recipient === 'canmore.create_textdoc' && str(call.content)) {
      const t = str(call.type)
      const language = t.startsWith('code/') ? t.slice(5).replace(/[^a-z0-9+#-]/gi, '') : t === 'document' ? 'markdown' : ''
      return { ...empty, artifacts: [{ title: titleOf(call.name) || 'Canvas', language, content: str(call.content) }] }
    }
    if (recipient === 'dalle.text2im' && str(call.prompt).trim()) return { ...empty, text: `🎨 *Image prompt:* ${str(call.prompt).trim()}` }
    return null
  }

  if (type !== 'text' && type !== 'multimodal_text') return null
  const texts: string[] = []
  for (const p of parts) {
    if (typeof p === 'string') texts.push(p)
    else if (isRec(p) && str(p.content_type) === 'audio_transcription' && str(p.text).trim()) texts.push(str(p.text))
  }
  const attachments: ChatAttachment[] = []
  for (const a of arr(meta.attachments)) {
    if (isRec(a) && str(a.name).trim()) attachments.push({ name: titleOf(a.name) })
  }
  const text = stripCitations(texts.join('\n')).trim()
  const images = imagesOfParts(parts)
  if (!text && !images.length && !attachments.length) return null
  return { role, time, text, attachments, images, artifacts: [] }
}

/** The visible thread of a ChatGPT message tree: from `current_node` up to the root, oldest first. */
function chatgptThread(mapping: Rec, current: string): Rec[] {
  const node = (id: string): Rec | null => {
    const n = mapping[id]
    return isRec(n) ? n : null
  }
  let leaf = current && node(current) ? current : ''
  if (!leaf) {
    // No current node: follow the newest child from the root.
    const root = Object.keys(mapping).find((k) => !str(node(k)?.parent))
    let at = root ?? ''
    const seen = new Set<string>()
    while (at && !seen.has(at)) {
      seen.add(at)
      const kids = arr(node(at)?.children).filter((k): k is string => typeof k === 'string' && !!node(k))
      if (!kids.length) break
      at = kids[kids.length - 1]!
    }
    leaf = at
  }
  const chain: Rec[] = []
  const seen = new Set<string>()
  for (let id = leaf; id && !seen.has(id); ) {
    seen.add(id)
    const n = node(id)
    if (!n) break
    if (isRec(n.message)) chain.push(n.message)
    id = str(n.parent)
  }
  return chain.reverse()
}

function chatgptConversation(c: Rec): ChatConversation | null {
  const id = str(c.conversation_id) || str(c.id)
  if (!id || !isRec(c.mapping)) return null
  const pieces = chatgptThread(c.mapping, str(c.current_node))
    .map(chatgptPiece)
    .filter((p): p is Piece => p !== null)
  const messages = mergeTurns(pieces)
  const gizmo = str(c.gizmo_id)
  return {
    source: 'chatgpt',
    id,
    title: titleOf(c.title, messages.find((m) => m.role === 'user')?.text) || 'Untitled chat',
    created: isoOf(c.create_time),
    updated: isoOf(c.update_time) ?? isoOf(c.create_time),
    url: `https://chatgpt.com/c/${encodeURIComponent(id)}`,
    projectId: gizmo.startsWith('g-p-') ? gizmo : null,
    gptId: gizmo && !gizmo.startsWith('g-p-') ? gizmo : null,
    model: str(c.default_model_slug) || null,
    messages,
  }
}

/** The web address of a ChatGPT project (`g-p-…`). */
export function chatgptProjectUrl(projectId: string): string {
  return `https://chatgpt.com/g/${encodeURIComponent(projectId)}/project`
}

/** Consecutive turns of the same speaker become one message (a reply split around a tool call, its pictures). */
function mergeTurns(list: Piece[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const p of list) {
    const last = out[out.length - 1]
    if (last && last.role === p.role) {
      if (p.text) last.text = last.text ? `${last.text}\n\n${p.text}` : p.text
      last.attachments.push(...p.attachments)
      last.images.push(...p.images)
      last.artifacts.push(...p.artifacts)
      last.time ??= p.time
    } else {
      out.push({ role: p.role, time: p.time, text: p.text, attachments: [...p.attachments], images: [...p.images], artifacts: [...p.artifacts] })
    }
  }
  return out
}
