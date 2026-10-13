/**
 * The MCP face of the brain: every tool the AI link offers, with the
 * conventions Claude and ChatGPT expect (snake_case names, titles, "Use this
 * when…" descriptions, explicit hints, `search` / `fetch` in the ChatGPT
 * connector shape). Write tools are not registered at all in read-only mode.
 * Every call reports one line of activity (for the app's toasts) with the
 * vault path it touched.
 */
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MAX_MESSAGE_CHARS, NOTE_TYPES } from '@aether/core'
import type { Brain } from './brain.js'
import { ABOUT_ME_AREAS, ABOUT_ME_SECTIONS, type AboutMeArea, type CheckIn } from './me.js'

/** One tool call, for the host's activity feed. */
export interface ActivityEvent {
  /** Who called: the MCP client name (stdio) or ChatGPT / Claude / AI client (HTTP). */
  client: string
  tool: string
  /** One line for a toast, e.g. `created "Portal ideas"`. */
  summary: string
  /** Vault path of the note or folder the call touched, if any. */
  path: string | null
  write: boolean
}

export interface McpServerOptions {
  /** Offer read tools only (also implied by a read-only brain). */
  readOnly: boolean
  onActivity?: (a: ActivityEvent) => void
  /** Client name for activity; defaults to the name the client gave in the MCP handshake. */
  getClient?: () => string
}

declare const __AETHER_VERSION__: string | undefined

/** Server version (the app's, stamped in by the bundle build). */
export const SERVER_VERSION: string = typeof __AETHER_VERSION__ === 'string' ? __AETHER_VERSION__ : '0.0.0-dev'

/** What the AI reads first. The first 512 characters stand on their own (some clients cut there). */
export const INSTRUCTIONS = `Aether Brain is the user's second brain: plain markdown notes in folders on their own disk. Notes link with [[wikilinks]]; folders follow PARA (Inbox, Projects, Areas, Resources, Archive). A project is a note (type: project) with a "## To do" list of "- [ ] task" lines; done tasks read "- [x] task ✅ YYYY-MM-DD". A project's home folder is a star; its subfolders are planets. Several roots (drives like D:\\ and F:\\) show as top folders D/ and F/. Start with vault_overview, then search_notes or read_note.

How to work with it:
- Name notes by title, alias, id or vault path (e.g. Projects/PORTALz.md). When a title is ambiguous the error lists the paths to use.
- get_project and read_note list tasks with their line numbers; set_task_done, edit_task and delete_task take that line or the task's text. Adding or deleting a task moves the lines below it: use the tasks list add_task and delete_task return, or pass the text with the line.
- daily_brief is the user's Today: overdue tasks, tasks due or scheduled today (📅 / ⏳ dates, #today, today's daily note) and the next task of each active project. Tick one off with set_task_done, passing the row's path as project and its line.
- New notes go to the Inbox unless you give a folder. A new note never overwrites anything (a taken name gets " 2"), only .md notes and folders are created, and no tool deletes a note.
- A planet is a folder inside a project's home folder: create_folder with project and path.
- Prefer small edits (edit_note, append_to_note, add_task) over rewriting whole notes, and keep the user's own words.
- When the user asks to save or remember this conversation, call save_chat: a title, a short summary (next steps as tasks) and the messages as faithfully as you can. With the chat's url it refreshes that chat note instead of making a new one.
- The brain also knows its user: when the conversation is personal (how they are, their family, health, goals, how they like to work), call about_me first. Ask before remembering anything personal, save it with remember_about_me (one fact, their words) and say what you saved. check_in records a short check-in; my_trends compares the last week with the weeks before; wellbeing_playbook holds the evidence and their early warning signs plan. You are a supportive companion, not a clinician: never diagnose or advise medication changes; their care team leads.`

/** Every tool: title, description (also used for the Claude Desktop extension manifest) and whether it writes. */
export const TOOLS = {
  search: {
    title: 'Search notes',
    write: false,
    description:
      "Use this when you need to find notes in the user's Aether Brain vault by words (ChatGPT connector search). Returns up to 10 results with id, title and a file URL; pass an id to fetch for the full text.",
  },
  fetch: {
    title: 'Fetch a note',
    write: false,
    description:
      'Use this when you have a note id from search and need its full markdown text, with metadata (path, tags, status, dates, links, backlinks).',
  },
  vault_overview: {
    title: 'Vault overview',
    write: false,
    description:
      "Use this when you start working with the user's second brain and need orientation: roots (drives), note and folder counts, PARA areas, top tags, the most linked notes, top folders, projects with progress, and recent notes.",
  },
  search_notes: {
    title: 'Search notes',
    write: false,
    description:
      'Use this when you need to find notes by words in titles, aliases, headings, tags, text or paths, optionally only inside a folder or with a tag. Returns path, tags and a snippet per hit; open one with read_note.',
  },
  read_note: {
    title: 'Read a note',
    write: false,
    description:
      'Use this when you need a note in full: frontmatter, markdown content, resolved [[links]], missing links, backlinks and its tasks with line numbers. The note can be named by title, alias, id or vault path.',
  },
  list_folder: {
    title: 'List a folder',
    write: false,
    description:
      'Use this when you need to see how the vault is organized: a folder\'s subfolders (planets and moons, with note counts and which ones are projects) and the notes directly inside it. Omit path for the top level; depth 1–4.',
  },
  list_projects: {
    title: 'List projects',
    write: false,
    description:
      'Use this when the user asks about their projects: every project with status, home folder, progress (done/total tasks), next open tasks and summary. Active projects first.',
  },
  get_project: {
    title: 'Get a project',
    write: false,
    description:
      'Use this when you need one project in detail: summary, status, every task with its line number and ✅ done date, its planets (subfolders of its home folder) and the notes inside it.',
  },
  daily_brief: {
    title: "Today's brief",
    write: false,
    description:
      "Use this when the user asks what's on today, what's due or overdue, or what to work on next: tasks from every note that are overdue, due or scheduled today, in today's daily note or tagged #today, plus the next open task of each active project. Each row has the task, its note (title and path), line, project, due date and why it is listed. Optional date (YYYY-MM-DD) for another day.",
  },
  related_notes: {
    title: 'Related notes',
    write: false,
    description: 'Use this when you want the notes connected to a note: the notes it links to, the notes linking to it, and notes with similar words.',
  },
  recent_notes: {
    title: 'Recent notes',
    write: false,
    description: 'Use this when the user asks what changed or what they worked on recently: notes by last change, newest first, optionally within some days or a folder.',
  },
  create_note: {
    title: 'Create a note',
    write: true,
    description:
      'Use this when the user wants a new note. Goes to the Inbox unless a folder is given; never overwrites (a taken name gets " 2"). Content is markdown; [[wikilinks]] link other notes.',
  },
  append_to_note: {
    title: 'Append to a note',
    write: true,
    description: 'Use this when adding text to an existing note: at the end, or at the end of the section under a heading (the heading is created when missing).',
  },
  edit_note: {
    title: 'Edit a note',
    write: true,
    description:
      'Use this when changing text inside a note: replaces old_text, which must occur exactly once (copy it from read_note, including line breaks), with new_text. Use an empty new_text to remove the passage.',
  },
  update_frontmatter: {
    title: 'Update note properties',
    write: true,
    description: 'Use this when setting or removing frontmatter (YAML) properties of a note, such as status, tags, area, type or aliases. A null value removes the key.',
  },
  save_chat: {
    title: 'Save this chat',
    write: true,
    description:
      "Use this when the user asks to save, keep or remember this conversation in their brain: writes it as a chat note, a short summary on top (live markdown: [[links]] and \"- [ ] next step\" tasks count) and then the transcript, under AI Chats (or a project's AI Chats planet). Pass the messages as faithfully as you can. With the chat's web address as url, saving again updates that chat note: its summary is replaced by the new one, and its transcript only when you pass more messages than it holds; nothing else in the vault changes.",
  },
  about_me: {
    title: 'About me',
    write: false,
    description:
      'Use this when the conversation is personal, or before advice that depends on who the user is: what they asked their brain to remember (Me/About me: who they are, how they like to be talked to, what matters, family, health and routine, work, goals, what helps, early warning signs, care team), which sections are still empty, and the trends of their last two weeks of check-ins.',
  },
  remember_about_me: {
    title: 'Remember about me',
    write: true,
    description:
      'Use this when the user agreed you should remember something about them (always ask first): adds one fact, in their words, as a dated line in its section of Me/About me (made when missing). Then tell them exactly what you saved. They can change or delete it in the note any time.',
  },
  check_in: {
    title: 'Check in',
    write: true,
    description:
      "Use this when the user answers a check-in: mood 1–10 (required), and as they give them hours of sleep, energy and stress 1–10, whether they took their medication (only if they track it), connection with family, one win, one worry. Adds a row to this month's Me/Check-ins note and returns the trends.",
  },
  my_trends: {
    title: 'My trends',
    write: false,
    description:
      'Use this when the user asks how they have been doing, or before a check-in conversation: their check-ins over the last days (7–90, default 14), the last week against the weeks before (mood, sleep, energy, stress), medication taken or missed, and plain-fact notices when something shifted. Name a shift neutrally and ask; never conclude.',
  },
  wellbeing_playbook: {
    title: 'Wellbeing playbook',
    write: false,
    description:
      "Use this when you need the evidence behind wellbeing advice, or the user's own plan: their copy of the Wellbeing playbook (sleep, movement, stress, early warning signs plan, recovery, work and creativity, family, the people they lean on), or one section of it with topic.",
  },
  capture: {
    title: 'Quick capture',
    write: true,
    description: 'Use this when the user wants to jot something down quickly: saves the text as a new note in the Inbox, titled from its first line.',
  },
  add_task: {
    title: 'Add a task',
    write: true,
    description: 'Use this when adding a to-do to a project (or any note): appends "- [ ] text" under its "## To do" section (or another section), created when missing.',
  },
  set_task_done: {
    title: 'Complete a task',
    write: true,
    description:
      'Use this when a task is finished (or should be reopened): marks it "[x]" with a "✅ YYYY-MM-DD" date of today. Name the task by its line (from get_project) or its text.',
  },
  edit_task: {
    title: 'Edit a task',
    write: true,
    description: 'Use this when rewording a task. Its checkbox and done date stay. Name the task by its line (from get_project) or its current text.',
  },
  delete_task: {
    title: 'Delete a task',
    write: true,
    description:
      'Use this when a task should be removed from a project entirely (not completed). Removes only that task line; the tasks below it move up one line, so use the tasks list in the reply for the next call.',
  },
  create_project: {
    title: 'Create a project',
    write: true,
    description:
      'Use this when the user starts a new project: creates the project note (summary, "## To do" tasks) in Projects and its home folder, the star its planets go in. Pass folder to use or turn an existing folder into the project.',
  },
  update_project: {
    title: 'Update a project',
    write: true,
    description:
      'Use this when renaming a project or changing its status, summary, tags or home folder. A rename keeps the old title as an alias, so existing [[links]] still work.',
  },
  create_folder: {
    title: 'Create a folder',
    write: true,
    description:
      "Use this when the user wants a new folder, such as a new planet inside a project: pass project and the folder name as path to create it inside that project's home folder, or a vault path.",
  },
  link_notes: {
    title: 'Link two notes',
    write: true,
    description: 'Use this when two notes belong together: appends "- Related: [[to]]" to the first note (nothing happens when it already links there).',
  },
} as const satisfies Record<string, { title: string; description: string; write: boolean }>

export type ToolName = keyof typeof TOOLS

/** Read tools never change anything; writes are either additive or change what is there. */
const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const ADDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const CHANGES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

/** Longest list a result carries (search hits, …); the rest is counted. */
const MAX_HITS = 50

/**
 * Longest markdown one argument may carry (a note body, text to append, a
 * passage to replace): about 200 KB, far more than a note needs. The parsing
 * is linear; the cap keeps one call from making the vault huge all the same.
 */
export const MAX_TEXT_ARG = 200_000
/** Longest one-line argument: titles, note and folder references, headings, tasks, tags, queries. */
export const MAX_LINE_ARG = 4_000
/** Longest list argument (tags, first tasks, keys to remove). */
export const MAX_LIST_ARG = 200
/**
 * Most messages one save_chat call takes, and most characters in all
 * (messages + summary): below the HTTP link's 1 MiB request cap, so a too
 * long chat gets this tool's own answer, not a transport error.
 */
export const MAX_CHAT_MESSAGES = 2_000
export const MAX_CHAT_CHARS = 800_000

/** A markdown text argument. */
const mdText = () => z.string().max(MAX_TEXT_ARG)
/** A one-line argument. */
const oneLine = () => z.string().max(MAX_LINE_ARG)

/** What a tool handler hands back: the reply text, the activity line, the touched path. */
interface Done {
  text: string
  summary: string
  path?: string | null
  structured?: Record<string, unknown>
}

/** A short human line followed by compact JSON. */
function reply(line: string, data: unknown): string {
  return `${line}\n${JSON.stringify(data)}`
}

function quote(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MESSAGE = 'date must be a real day written YYYY-MM-DD, e.g. 2026-10-01'

/** True for a real day written YYYY-MM-DD (not 2026-02-30). */
function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

/** How daily_brief tells the AI to tick a row off. */
const TICK_HINT = "Tick a task off with set_task_done: the row's path as project and its line (its text as task too, to be safe)."

/** Said when a task reply lists the current lines because the note changed since they were listed. */
function relisted(r: { tasks?: unknown }): string {
  return r.tasks ? ' The note had changed since its tasks were listed: use the lines in tasks from now on.' : ''
}

// Shared input fields.
const noteArg = oneLine().min(1).describe('The note: its title, alias, id or vault path (e.g. "Projects/PORTALz.md").')
const projectArg = oneLine().min(1).describe('The project: its title, alias, id, vault path, or its home folder.')
const lineArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'Line number of the task (0-based), as the last reply that listed it gave it (get_project, read_note, add_task, delete_task, or a task tool\'s tasks or error). Lines move when a task above is added or deleted; when the note changed since that listing, the task that was on the line is found again, or the call is refused with the current lines. Also passing task is safest.',
  )
const taskArg = oneLine().optional().describe('The task text (or a unique part of it), when you do not have its line.')
const tagsArg = z.array(oneLine()).max(MAX_LIST_ARG).optional().describe('Tags without "#", e.g. ["portal", "concept-art"].')

/**
 * An MCP server over `brain` with every tool of the AI link. A fresh one per
 * HTTP request is cheap (tools are plain registrations).
 */
export function createMcpServer(brain: Brain, opts: McpServerOptions): McpServer {
  const readOnly = opts.readOnly || brain.readOnly
  const server = new McpServer(
    { name: 'aether-brain', title: 'Aether Brain', version: SERVER_VERSION },
    {
      instructions: readOnly
        ? `${INSTRUCTIONS}\n\nThis link is read-only: you can search and read the vault, but not change it.`
        : INSTRUCTIONS,
    },
  )
  const client = (): string => opts.getClient?.() ?? server.server.getClientVersion()?.name ?? 'AI client'
  const emit = (a: Omit<ActivityEvent, 'client'>): void => {
    try {
      opts.onActivity?.({ client: client(), ...a })
    } catch {
      /* a broken listener never fails a tool call */
    }
  }

  const tool = <S extends ZodRawShapeCompat>(
    name: ToolName,
    input: S,
    hints: ToolAnnotations,
    run: (args: ShapeOutput<S>) => Promise<Done>,
    output?: ZodRawShapeCompat,
  ): void => {
    const info = TOOLS[name]
    if (info.write && readOnly) return
    const handler = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
      try {
        const done = await run(args)
        emit({ tool: name, summary: done.summary, path: done.path ?? null, write: info.write })
        const content = [{ type: 'text' as const, text: done.text }]
        return done.structured ? { content, structuredContent: done.structured } : { content }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit({ tool: name, summary: `${name} failed: ${message}`.slice(0, 200), path: null, write: info.write })
        return { content: [{ type: 'text', text: message }], isError: true }
      }
    }
    server.registerTool(
      name,
      {
        title: info.title,
        description: info.description,
        inputSchema: input,
        ...(output ? { outputSchema: output } : {}),
        annotations: { title: info.title, ...hints },
      },
      // ToolCallback<S> is a conditional type TypeScript cannot resolve for a generic S; it is this signature.
      handler as unknown as ToolCallback<S>,
    )
  }

  /* ---------------------------- read ---------------------------- */

  tool(
    'search',
    { query: oneLine().describe('Words to look for.') },
    READ,
    async ({ query }) => {
      const results = await brain.find(query, 10)
      const structured = { results }
      return { text: JSON.stringify(structured), structured, summary: `searched ${quote(query)}` }
    },
    { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) },
  )

  tool(
    'fetch',
    { id: oneLine().min(1).describe('A note id from search (a title or vault path works too).') },
    READ,
    async ({ id }) => {
      const doc = await brain.fetch(id)
      return { text: JSON.stringify(doc), structured: doc, summary: `read ${quote(doc.title)}`, path: doc.metadata['path'] ?? null }
    },
    { id: z.string(), title: z.string(), text: z.string(), url: z.string(), metadata: z.record(z.string(), z.string()).optional() },
  )

  tool('vault_overview', {}, READ, async () => {
    const o = await brain.overview()
    return {
      text: reply(`${plural(o.notes, 'note')} in ${plural(o.folders, 'folder')}, ${plural(o.projectCount, 'project')}.`, o),
      summary: 'looked at the vault overview',
    }
  })

  tool(
    'search_notes',
    {
      query: oneLine().min(1).describe('Words to look for (all words must match; falls back to any word).'),
      limit: z.number().int().min(1).max(MAX_HITS).optional().describe('How many hits (default 10, max 50).'),
      folder: oneLine().optional().describe('Only notes inside this folder (vault path), e.g. "Projects/PORTALz".'),
      tag: oneLine().optional().describe('Only notes with this tag.'),
    },
    READ,
    async ({ query, limit, folder, tag }) => {
      const r = await brain.searchNotes(query, { ...(limit ? { limit } : {}), ...(folder ? { folder } : {}), ...(tag ? { tag } : {}) })
      const line = r.hits.length ? `${plural(r.hits.length, 'hit')}${r.truncated ? ' (more exist: raise limit or narrow the query)' : ''}.` : 'No notes match.'
      return { text: reply(line, r), summary: `searched ${quote(query)}`, path: r.folder }
    },
  )

  tool('read_note', { note: noteArg }, READ, async ({ note }) => {
    const n = await brain.readNote(note)
    const line = `${quote(n.title, 120)} at ${n.path}: ${plural(n.links.length, 'link')}, ${plural(n.backlinkCount, 'backlink')}, ${plural(n.tasks.length, 'task')}.`
    return { text: reply(line, n), summary: `read ${quote(n.title)}`, path: n.path }
  })

  tool(
    'list_folder',
    {
      path: oneLine().optional().describe('Folder vault path, e.g. "Projects/PORTALz" (a drive in a multi-root vault: "D"). Omit for the top level.'),
      depth: z.number().int().min(1).max(4).optional().describe('Levels of subfolders to include (default 1, max 4).'),
    },
    READ,
    async ({ path, depth }) => {
      const r = await brain.listFolder(path, depth ?? 1)
      const f = r.folder
      const line = `${f.path || 'Vault root'}: ${plural(f.folders, 'subfolder')}, ${plural(f.notes, 'note')} here, ${f.total} in total.`
      return { text: reply(line, r), summary: `listed ${f.path || 'the vault'}`, path: f.path || null }
    },
  )

  tool(
    'list_projects',
    {
      status: oneLine().optional().describe('Only projects with this status, e.g. "active".'),
      limit: z.number().int().min(1).max(100).optional().describe('How many (default 50).'),
    },
    READ,
    async ({ status, limit }) => {
      const r = await brain.listProjects({ ...(status ? { status } : {}), ...(limit ? { limit } : {}) })
      const line = `${plural(r.total, 'project')}${r.projects.length < r.total ? `, first ${r.projects.length} shown` : ''}.`
      return { text: reply(line, r), summary: 'listed projects' }
    },
  )

  tool('get_project', { project: projectArg }, READ, async ({ project }) => {
    const p = await brain.getProject(project)
    const open = p.tasks.filter((t) => !t.done).length
    const line = `Project ${quote(p.title, 120)} (${p.status ?? 'no status'}): ${p.progress} tasks done, ${open} open, ${plural(p.planets.length, 'planet')}.`
    return { text: reply(line, p), summary: `opened project ${quote(p.title)}`, path: p.path }
  })

  tool(
    'daily_brief',
    {
      date: oneLine()
        .regex(DAY_RE, DAY_MESSAGE)
        .refine(isDay, DAY_MESSAGE)
        .optional()
        .describe('The day, YYYY-MM-DD (default: today on the user\'s computer).'),
    },
    READ,
    async ({ date }) => {
      const b = await brain.dailyBrief(date)
      const day = date ? `The brief for ${b.date}` : `Today (${b.date})`
      // A read-only link offers no set_task_done: no hint to use it then.
      const line = b.total
        ? `${day}: ${b.overdue.length} overdue, ${b.today.length} for the day, ${b.next.length} next up.${readOnly ? '' : ` ${TICK_HINT}`}`
        : `${day}: nothing is overdue, due or planned, and no active project has an open task.`
      return { text: reply(line, readOnly ? b : { ...b, howToTick: TICK_HINT }), summary: date ? `looked at the brief for ${b.date}` : "looked at today's brief" }
    },
  )

  tool(
    'related_notes',
    { note: noteArg, limit: z.number().int().min(1).max(30).optional().describe('How many similar notes (default 10).') },
    READ,
    async ({ note, limit }) => {
      const r = await brain.related(note, limit ?? 10)
      const line = `${quote(r.note.title, 120)} links to ${r.linksTo.length}, is linked from ${r.linkedFrom.length}; ${plural(r.similar.length, 'similar note')}.`
      return { text: reply(line, r), summary: `looked at notes related to ${quote(r.note.title)}`, path: r.note.path }
    },
  )

  tool(
    'recent_notes',
    {
      limit: z.number().int().min(1).max(100).optional().describe('How many (default 15).'),
      days: z.number().int().min(1).max(3650).optional().describe('Only notes changed in the last N days.'),
      folder: oneLine().optional().describe('Only notes inside this folder (vault path).'),
    },
    READ,
    async ({ limit, days, folder }) => {
      const r = await brain.recent({ ...(limit ? { limit } : {}), ...(days ? { days } : {}), ...(folder ? { folder } : {}) })
      return { text: reply(`${plural(r.notes.length, 'note')}, newest first.`, r), summary: 'listed recent notes', path: r.folder }
    },
  )

  /* ---------------------------- write --------------------------- */

  tool(
    'create_note',
    {
      title: oneLine().min(1).describe('Note title (also the file name).'),
      folder: oneLine().optional().describe('Folder vault path, e.g. "Resources/Lighting" (default: the Inbox). Created when missing.'),
      content: mdText().optional().describe('Markdown body. A leading "# Heading" replaces the default title heading.'),
      tags: tagsArg,
      type: z.enum(NOTE_TYPES).optional().describe('Note type for frontmatter.'),
    },
    ADDS,
    async ({ title, folder, content, tags, type }) => {
      const n = await brain.createNote({ title, ...(folder ? { folder } : {}), ...(content ? { content } : {}), ...(tags ? { tags } : {}), ...(type ? { type } : {}) })
      return { text: reply(`Created ${n.path}.`, n), summary: `created ${quote(n.title)}`, path: n.path }
    },
  )

  /* ------------------------------ Me ------------------------------ */

  tool('about_me', {}, READ, async () => {
    const me = await brain.aboutMe()
    const line = me.exists
      ? `About me at ${me.path}${me.empty.length ? `; not filled in yet: ${me.empty.join(', ')}` : ''}. ${plural(me.checkIns.count, 'check-in')} in the last two weeks.`
      : `There is no About me yet (${me.path}): nothing remembered so far. Offer to get to know them, one question at a time, and remember what they agree to.`
    return { text: reply(line, me), summary: 'read About me', path: me.exists ? me.path : null }
  })

  tool(
    'remember_about_me',
    {
      area: z
        .enum(ABOUT_ME_AREAS as [AboutMeArea, ...AboutMeArea[]])
        .describe(`Where it belongs: ${Object.entries(ABOUT_ME_SECTIONS).map(([k, v]) => `${k} (${v})`).join(', ')}.`),
      fact: mdText().min(1).max(500).describe('One fact, in their words, e.g. "Sketches best in the morning with music on".'),
    },
    ADDS,
    async ({ area, fact }) => {
      const r = await brain.rememberAboutMe(area, fact)
      return { text: reply(`Remembered under "${r.section}" in ${r.path}.`, r), summary: `remembered: ${quote(fact, 60)}`, path: r.path }
    },
  )

  tool(
    'check_in',
    {
      mood: z.number().min(1).max(10).describe('Mood today, 1 (very low) to 10 (great).'),
      sleep: z.number().min(0).max(24).optional().describe('Hours slept last night.'),
      energy: z.number().min(1).max(10).optional().describe('Energy, 1–10.'),
      stress: z.number().min(1).max(10).optional().describe('Stress, 1–10.'),
      meds: z.boolean().optional().describe('Took their medication as planned today (only if they track it).'),
      family: oneLine().max(300).optional().describe('Connection with family today, in their words.'),
      win: oneLine().max(300).optional().describe('One win today.'),
      worry: oneLine().max(300).optional().describe('One worry today.'),
      note: oneLine().max(300).optional().describe('Anything else they want noted.'),
    },
    ADDS,
    async (args) => {
      const entry: CheckIn = { mood: args.mood }
      if (args.sleep !== undefined) entry.sleep = args.sleep
      if (args.energy !== undefined) entry.energy = args.energy
      if (args.stress !== undefined) entry.stress = args.stress
      if (args.meds !== undefined) entry.meds = args.meds
      if (args.family) entry.family = args.family
      if (args.win) entry.win = args.win
      if (args.worry) entry.worry = args.worry
      if (args.note) entry.note = args.note
      const r = await brain.checkIn(entry)
      return { text: reply(`Check-in saved in ${r.path}.`, r), summary: 'saved a check-in', path: r.path }
    },
  )

  tool(
    'my_trends',
    { days: z.number().int().min(7).max(90).optional().describe('How many days back (7–90, default 14).') },
    READ,
    async ({ days }) => {
      const t = await brain.trends(days ?? 14)
      const line = t.count ? `${plural(t.count, 'check-in')} in the last ${t.days} days.${t.notices.length ? ` Notices: ${t.notices.join(' ')}` : ''}` : `No check-ins in the last ${t.days} days.`
      return { text: reply(line, t), summary: 'looked at the check-in trends' }
    },
  )

  tool(
    'wellbeing_playbook',
    { topic: oneLine().optional().describe('Only the section whose heading contains this, e.g. "sleep", "early warning", "family".') },
    READ,
    async ({ topic }) => {
      const r = await brain.playbook(topic)
      return { text: r.text, summary: topic ? `read the playbook on ${quote(topic)}` : 'read the playbook', path: r.path }
    },
  )

  tool(
    'save_chat',
    {
      title: oneLine().min(1).describe('What the chat was about, e.g. "Portal lighting". The note is named "<today> <title>".'),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']).describe('user: the person; assistant: you.'),
            text: mdText().describe('The message, as written (markdown).'),
          }),
        )
        .max(MAX_CHAT_MESSAGES)
        .default([])
        .describe('The conversation, oldest first.'),
      summary: mdText().optional().describe('A short summary for the top of the note: decisions, ideas, next steps as "- [ ] task" lines.'),
      source: z.enum(['claude', 'chatgpt']).optional().describe('Who you are (default: from the client name).'),
      url: oneLine().optional().describe('The chat\'s web address (https://claude.ai/chat/… or https://chatgpt.com/c/…), if you know it.'),
      project: oneLine().optional().describe('Save into this project\'s "AI Chats" planet and link it.'),
      folder: oneLine().optional().describe('Or a folder vault path to save into.'),
    },
    CHANGES,
    async ({ title, messages, summary, source, url, project, folder }) => {
      const total = messages.reduce((n, m) => n + m.text.length, 0) + (summary?.length ?? 0)
      if (total > MAX_CHAT_CHARS) {
        throw new Error(
          `The chat is too long to save in one call (${total.toLocaleString('en-US')} characters, at most ${MAX_CHAT_CHARS.toLocaleString('en-US')}). Save a summary and the most important messages instead.`,
        )
      }
      const name = client()
      const who = source ?? (/gpt|openai/i.test(name) ? 'chatgpt' : /claude|anthropic/i.test(name) ? 'claude' : null)
      if (!who) throw new Error('Say which assistant you are: pass source "claude" or "chatgpt"')
      const n = await brain.saveChat({ title, messages, source: who, ...(summary ? { summary } : {}), ...(url ? { url } : {}), ...(project ? { project } : {}), ...(folder ? { folder } : {}) })
      const cut = n.cut ? ` ${plural(n.cut, 'message was', 'messages were')} longer than ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters and cut.` : ''
      const line = n.kept
        ? `${n.path} already has this: nothing changed (a transcript is only rewritten when it gets more messages).`
        : n.updated
          ? `Updated ${n.path}: summary ${summary?.trim() ? 'replaced' : 'kept'}, transcript ${n.transcript}.`
          : `Saved ${n.path}.`
      return {
        text: reply(`${line}${cut}`, n),
        summary: `${n.updated || n.kept ? 'updated' : 'saved'} the chat ${quote(n.title)}`,
        path: n.path,
      }
    },
  )

  tool(
    'append_to_note',
    {
      note: noteArg,
      text: mdText().min(1).describe('Markdown to add.'),
      heading: oneLine().optional().describe('Add at the end of this section (heading text, any level); created when missing.'),
    },
    ADDS,
    async ({ note, text, heading }) => {
      const n = await brain.appendToNote(note, text, heading)
      return { text: reply(`Added to ${n.path}${heading ? ` under "${heading}"` : ''}.`, n), summary: `added to ${quote(n.title)}`, path: n.path }
    },
  )

  tool(
    'edit_note',
    {
      note: noteArg,
      old_text: mdText().min(1).describe('Exact text to replace; must occur exactly once in the note.'),
      new_text: mdText().describe('Replacement text (empty removes old_text).'),
    },
    CHANGES,
    async ({ note, old_text, new_text }) => {
      const r = await brain.editNote(note, old_text, new_text)
      return { text: reply(r.changed ? `Edited ${r.path}.` : `No change: the new text is the same.`, r), summary: `edited ${quote(r.title)}`, path: r.path }
    },
  )

  tool(
    'update_frontmatter',
    {
      note: noteArg,
      set: z
        .record(oneLine(), z.unknown())
        .refine((v) => JSON.stringify(v).length <= MAX_TEXT_ARG, { message: `Properties must be under ${MAX_TEXT_ARG} characters in all` })
        .optional()
        .describe('Properties to set, e.g. {"status": "active", "tags": ["portal"]}. null removes a key.'),
      remove: z.array(oneLine()).max(MAX_LIST_ARG).optional().describe('Property names to remove.'),
    },
    { ...CHANGES, idempotentHint: true },
    async ({ note, set, remove }) => {
      const r = await brain.updateFrontmatter(note, set ?? {}, remove ?? [])
      return { text: reply(`Updated the properties of ${r.path}.`, r), summary: `updated properties of ${quote(r.title)}`, path: r.path }
    },
  )

  tool(
    'capture',
    {
      text: mdText().min(1).describe('What to jot down (markdown). The first line becomes the title.'),
      title: oneLine().optional().describe('Explicit title instead of the first line.'),
      tags: tagsArg,
    },
    ADDS,
    async ({ text, title, tags }) => {
      const n = await brain.capture({ text, ...(title ? { title } : {}), ...(tags ? { tags } : {}) })
      return { text: reply(`Captured to ${n.path}.`, n), summary: `captured ${quote(n.title)}`, path: n.path }
    },
  )

  tool(
    'add_task',
    {
      project: projectArg,
      text: oneLine().min(1).describe('The task, e.g. "Block out the gate chamber".'),
      section: oneLine().optional().describe('Heading to add it under (default "To do").'),
    },
    ADDS,
    async ({ project, text, section }) => {
      const r = await brain.addTask(project, text, section ?? 'To do')
      const where = r.task ? ` on line ${r.task.line}` : ''
      return { text: reply(`Added the task to ${r.note.path}${where}.`, r), summary: `added task ${quote(text)} to ${quote(r.note.title)}`, path: r.note.path }
    },
  )

  tool(
    'set_task_done',
    {
      project: projectArg,
      line: lineArg,
      task: taskArg,
      done: z.boolean().optional().describe('true (default) marks it done with today\'s date; false reopens it.'),
    },
    { ...ADDS, idempotentHint: true },
    async ({ project, line, task, done }) => {
      const finish = done ?? true
      const r = await brain.setTaskDone(project, { ...(line !== undefined ? { line } : {}), ...(task ? { task } : {}) }, finish)
      const text = r.task?.text ?? task ?? ''
      const message = r.changed
        ? `${finish ? 'Completed' : 'Reopened'} ${quote(text, 120)} in ${r.note.path}.`
        : `No change: the task was already ${finish ? 'done' : 'open'}.`
      return { text: reply(`${message}${relisted(r)}`, r), summary: `${finish ? 'completed' : 'reopened'} ${quote(text)}`, path: r.note.path }
    },
  )

  tool(
    'edit_task',
    { project: projectArg, line: lineArg, task: taskArg, text: oneLine().min(1).describe('The new task text.') },
    { ...CHANGES, idempotentHint: true },
    async ({ project, line, task, text }) => {
      const r = await brain.editTask(project, { ...(line !== undefined ? { line } : {}), ...(task ? { task } : {}) }, text)
      return { text: reply(`${r.changed ? `Edited the task in ${r.note.path}.` : 'No change.'}${relisted(r)}`, r), summary: `edited task ${quote(text)}`, path: r.note.path }
    },
  )

  tool('delete_task', { project: projectArg, line: lineArg, task: taskArg }, CHANGES, async ({ project, line, task }) => {
    const r = await brain.deleteTask(project, { ...(line !== undefined ? { line } : {}), ...(task ? { task } : {}) })
    const said = `Deleted ${quote(r.deleted.text, 120)} from ${r.note.path}; tasks below line ${r.deleted.line} moved up one line (current lines in tasks).`
    return { text: reply(said, r), summary: `deleted task ${quote(r.deleted.text)}`, path: r.note.path }
  })

  tool(
    'create_project',
    {
      title: oneLine().optional().describe('Project name (optional when folder names an existing folder to turn into a project).'),
      summary: oneLine().optional().describe('One line on what the project is and what done looks like.'),
      tags: tagsArg,
      tasks: z.array(oneLine()).max(MAX_LIST_ARG).optional().describe('First to-dos.'),
      folder: oneLine().optional().describe('Home folder (vault path). Its own name as title makes that folder the project itself.'),
      make_folder: z.boolean().optional().describe('Create a home folder Projects/<title> for planets when no folder is given (default true).'),
    },
    ADDS,
    async ({ title, summary, tags, tasks, folder, make_folder }) => {
      const r = await brain.createProject({
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(tags ? { tags } : {}),
        ...(tasks ? { tasks } : {}),
        ...(folder ? { folder } : {}),
        ...(make_folder !== undefined ? { makeFolder: make_folder } : {}),
      })
      const home = r.folder ? ` with home folder ${r.folder}` : ''
      return { text: reply(`Created project ${quote(r.project.title, 120)} at ${r.project.path}${home}.`, r), summary: `created project ${quote(r.project.title)}`, path: r.project.path }
    },
  )

  tool(
    'update_project',
    {
      project: projectArg,
      title: oneLine().optional().describe('New name (the old one stays as an alias).'),
      status: oneLine().nullable().optional().describe('e.g. active, paused, done; null removes it.'),
      summary: oneLine().nullable().optional().describe('New one-line summary; empty or null removes it.'),
      tags: z.array(oneLine()).max(MAX_LIST_ARG).optional().describe('Replaces all tags.'),
      folder: oneLine().nullable().optional().describe('New home folder (vault path, created when missing); null unbinds it.'),
    },
    { ...CHANGES, idempotentHint: true },
    async ({ project, title, status, summary, tags, folder }) => {
      const r = await brain.updateProject(project, {
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(folder !== undefined ? { folder } : {}),
      })
      return {
        text: reply(r.changed ? `Updated project ${quote(r.project.title, 120)}.` : 'No change.', r),
        summary: `updated project ${quote(r.project.title)}`,
        path: r.project.path,
      }
    },
  )

  tool(
    'create_folder',
    {
      path: oneLine().min(1).describe('Folder vault path, e.g. "Resources/Lighting"; with project, a name inside the project folder, e.g. "Sound".'),
      project: oneLine().optional().describe('Create the folder inside this project\'s home folder (a new planet).'),
    },
    { ...ADDS, idempotentHint: true },
    async ({ path, project }) => {
      const r = await brain.createFolder(path, project)
      return { text: reply(r.created ? `Created folder ${r.path}.` : `Folder ${r.path} already exists.`, r), summary: `created folder ${r.path}`, path: r.path }
    },
  )

  tool(
    'link_notes',
    { from: noteArg.describe('The note that gets the link.'), to: noteArg.describe('The note it links to.') },
    { ...ADDS, idempotentHint: true },
    async ({ from, to }) => {
      const r = await brain.linkNotes(from, to)
      const line = r.added ? `Linked ${quote(r.from.title, 80)} → ${quote(r.to.title, 80)}.` : `${quote(r.from.title, 80)} already links to ${quote(r.to.title, 80)}.`
      return { text: reply(line, r), summary: `linked ${quote(r.from.title, 40)} → ${quote(r.to.title, 40)}`, path: r.from.path }
    },
  )

  return server
}
