/**
 * The librarian's decisions, pure: where one picture goes (Type › Genre ›
 * Year, taste and subject tags) from what its metadata, name, folders and the
 * vision helper say; free names per folder; the summary the panel shows; and
 * the index notes that link the library into the brain. Everything here is
 * data in, data out (tested without a disk).
 */
import { dateFromName, type PictureMeta } from './meta.js'
import {
  GENRES,
  SUBJECTS,
  UNDATED,
  UNSORTED,
  VISION_TYPES,
  familyOf,
  genreByWords,
  safeName,
  tasteTags,
  typeByRules,
  type ColourStats,
  type LibraryType,
} from './classify.js'

/** The vision model's type wins over a folder-name guess from this probability on. */
export const TYPE_SURE = 0.6
/** …and decides alone, when nothing else says, from this one. */
export const TYPE_MIN = 0.4
export const GENRE_MIN = 0.35
export const SUBJECT_MIN = 0.3
/** Descriptions kept per set (in the cache, the manifest): the best few, from this probability on. */
const PICK_KEEP = 0.05
const PICKS_PER_SET = 3

/** What the vision helper saw in a picture, as kept: its colours, and per set the best descriptions as [index, probability]. */
export interface Seen {
  colours: ColourStats | null
  picks: Record<string, [number, number][]> | null
}

/** The best few descriptions of each set (probability ≥ 5 %, at most three, best first, rounded). */
export function picksOf(probs: Record<string, number[]>): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {}
  for (const [k, list] of Object.entries(probs)) {
    out[k] = list
      .map((p, i): [number, number] => [i, Math.round(p * 1000) / 1000])
      .filter(([, p]) => p >= PICK_KEEP)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PICKS_PER_SET)
  }
  return out
}

function best(seen: Seen | null, set: string): { i: number; p: number } | null {
  const top = seen?.picks?.[set]?.[0]
  return top ? { i: top[0], p: top[1] } : null
}

/** One picture of the source, as the librarian knows it. */
export interface Picture {
  abs: string
  /** Path inside the source folder, `/`-separated. */
  rel: string
  size: number
  /** Last modified, epoch ms. */
  mtime: number
  meta: PictureMeta
  /** SHA-256 of its bytes, once something needed it (duplicates, a taken name). */
  sha?: string
}

export interface Placement {
  type: LibraryType
  /** Null for types without genres (Documents, Other). */
  genre: string | null
  /** `2024`, or `Undated`. */
  year: string
  /** Where the year comes from: the photo's own date (EXIF), its name, or the file's date. */
  dateFrom: 'photo' | 'name' | 'file' | null
  /** Taste (colour mood) and subject tags. */
  tags: string[]
  /** Why it is that type, in a few words. */
  why: string
}

const pct = (p: number) => `${Math.round(p * 100)}%`

/** The year a picture belongs to: the photo's own date, else a date in its name, else the file's date. */
function yearOf(p: Picture, now: Date): Pick<Placement, 'year' | 'dateFrom'> {
  if (p.meta.taken) return { year: p.meta.taken.slice(0, 4), dateFrom: 'photo' }
  const named = dateFromName(p.rel.slice(p.rel.lastIndexOf('/') + 1))
  if (named) return { year: named.slice(0, 4), dateFrom: 'name' }
  const y = new Date(p.mtime).getFullYear()
  if (Number.isFinite(y) && y >= 1980 && y <= now.getFullYear() + 1) return { year: String(y), dateFrom: 'file' }
  return { year: UNDATED, dateFrom: null }
}

/** Where one picture goes, and its tags. */
export function place(p: Picture, seen: Seen | null, now = new Date()): Placement {
  const name = p.rel.slice(p.rel.lastIndexOf('/') + 1)
  const rule = typeByRules(p.meta, name, p.rel)
  const v = best(seen, 'type')
  const seenType = v ? (VISION_TYPES[v.i] ?? null) : null
  let type: LibraryType
  let why: string
  if (rule.sure && rule.type) [type, why] = [rule.type, rule.why]
  else if (seenType && v && v.p >= TYPE_SURE) [type, why] = [seenType, `looks like it (${pct(v.p)})`]
  else if (rule.type) [type, why] = [rule.type, rule.why]
  else if (seenType && v && v.p >= TYPE_MIN) [type, why] = [seenType, `looks like it (${pct(v.p)})`]
  else [type, why] = ['Other', 'nothing says what it is']

  const family = familyOf(type)
  let genre: string | null = null
  if (type !== 'Documents' && type !== 'Other') {
    genre = genreByWords(family, p.rel)
    if (!genre && family !== 'doc') {
      const g = best(seen, `genre:${family}`)
      const named = g ? GENRES[family][g.i] : undefined
      if (g && named && g.p >= GENRE_MIN) genre = named.name
    }
    genre ??= UNSORTED
  }

  const tags = seen?.colours ? tasteTags(seen.colours) : []
  if (family === 'art' || family === 'photo') {
    for (const [i, prob] of seen?.picks?.['subject'] ?? []) {
      const s = SUBJECTS[i]
      if (s && prob >= SUBJECT_MIN && tags.length < 12) tags.push(s.tag)
    }
  }
  return { type, genre, ...yearOf(p, now), tags, why }
}

/** The folder a placement goes to inside the library: `Concept Art/Sci-Fi/2024`, `Documents/2024`. */
export function folderOf(pl: Placement): string {
  return [pl.type, pl.genre, pl.year].filter((s): s is string => !!s).map(safeName).join('/')
}

/** A file name as compared for "the same name" (Windows and macOS ignore letter case). */
export const nameKey = (name: string): string => name.normalize('NFC').toLowerCase()

/** `gate.png`, then `gate (2).png`, `gate (3).png` …: the first not in `taken` (nameKeys). */
export function freeName(name: string, taken: Set<string>): string {
  const safe = safeName(name)
  if (!taken.has(nameKey(safe))) return safe
  const dot = safe.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, '']
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`
    if (!taken.has(nameKey(next))) return next
  }
}

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

export type ItemStatus = 'new' | 'copied' | 'duplicate' | 'removed'

export interface PlanItem {
  id: number
  pic: Picture
  placement: Placement
  /** Path inside the library, `/`-separated. */
  dest: string
  /**
   * new: to copy; copied: in the library already (an earlier run, or this
   * one); duplicate: the same bytes as another picture; removed: copied
   * before and deleted from the library since (left out for good).
   */
  status: ItemStatus
  /** For a duplicate: the library path of the picture it repeats (or the item that will be copied). */
  duplicateOf?: string
}

/**
 * Names inside each library folder, free of each other and of `taken`
 * (library paths already used, by nameKey of the path). Items are taken in
 * order; each new one gets the first free name.
 */
export function assignDests(items: PlanItem[], taken: Iterable<string>): void {
  const byFolder = new Map<string, Set<string>>()
  const used = (folder: string) => {
    let s = byFolder.get(folder)
    if (!s) byFolder.set(folder, (s = new Set()))
    return s
  }
  for (const t of taken) {
    const i = t.lastIndexOf('/')
    used(nameKey(t.slice(0, Math.max(0, i)))).add(nameKey(t.slice(i + 1)))
  }
  for (const it of items) {
    if (it.status !== 'new') continue
    const folder = folderOf(it.placement)
    const names = used(nameKey(folder))
    const name = freeName(it.pic.rel.slice(it.pic.rel.lastIndexOf('/') + 1), names)
    names.add(nameKey(name))
    it.dest = `${folder}/${name}`
  }
}

/* ------------------------------------------------------------------ */
/* The library's index                                                 */
/* ------------------------------------------------------------------ */

/** One picture in the library, as the manifest (and the index notes) know it. */
export interface Shelved {
  /** Path inside the library. */
  dest: string
  type: LibraryType
  genre: string | null
  year: string
  tags: string[]
  size: number
  /** The source file's last-modified time (epoch ms): newest first in the notes. */
  mtime: number
}

/** Taste tags as the notes call them. */
export const TASTE_NAMES: Record<string, string> = {
  'dark-moody': 'Dark & moody',
  bright: 'Bright',
  monochrome: 'Monochrome',
  muted: 'Muted',
  vibrant: 'Vibrant',
  warm: 'Warm',
  cool: 'Cool',
  'high-contrast': 'High contrast',
}

const SUBJECT_TAGS = new Set(SUBJECTS.map((s) => s.tag))
/** How many pictures each index note shows. */
export const SAMPLES = 24
const TASTE_FOLDER = 'Taste'

export interface LibraryNote {
  /** Path inside the library. */
  path: string
  title: string
  tags: string[]
  /** What the note says above its Library section the first time it is written (the rest of the note is the user's). */
  intro: string
  /** The `## Library` section, rewritten on every run. */
  section: string
}

/** `concept-art`, `sci-fi`, `memes-web`: a name as a tag. */
export function tagOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

function tally<T>(list: T[], key: (x: T) => string[]): [string, number][] {
  const m = new Map<string, number>()
  for (const x of list) for (const k of key(x)) m.set(k, (m.get(k) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** `../` steps from a note in `from` (a library folder) up to the library. */
function upTo(from: string): string {
  return from ? '../'.repeat(from.split('/').length) : ''
}

/** Embeds of the newest pictures of `list`, written relative to a note in `from`. */
function samples(list: Shelved[], from: string): string {
  const prefix = upTo(from)
  const rel = (dest: string) => (from && dest.startsWith(`${from}/`) ? dest.slice(from.length + 1) : prefix + dest)
  return [...list]
    .sort((a, b) => b.mtime - a.mtime || a.dest.localeCompare(b.dest))
    .slice(0, SAMPLES)
    .map((s) => `![[${rel(s.dest)}]]`)
    .join('\n')
}

/**
 * The library's index notes: the hub (`<library>/<library>.md`, a project,
 * so the library is a star in the brain and ⇧G opens every picture under it),
 * a note per type and per genre (the folder notes of their folders), and a
 * note per taste. Each links up to its parent and shows its newest pictures.
 */
export function libraryNotes(lib: string, shelved: Shelved[], info: { source: string; day: string }): LibraryNote[] {
  const notes: LibraryNote[] = []
  const hubTitle = lib
  const typeTitle = (t: string) => `${lib} · ${t}`
  const genreTitle = (t: string, g: string) => `${lib} · ${t} · ${g}`
  const tasteTitle = (t: string) => `${lib} · Taste · ${TASTE_NAMES[t] ?? t}`
  const link = (title: string, label: string) => `[[${title}|${label}]]`
  const bytes = (list: Shelved[]) => list.reduce((a, s) => a + s.size, 0)
  const line = (list: Shelved[]) => `${count(list.length, 'picture')} · ${formatBytes(bytes(list))}`
  const tasteLine = (list: Shelved[]) => {
    const t = tally(list, (s) => s.tags.filter((x) => x in TASTE_NAMES))
    return t.length ? `Taste: ${t.map(([k, n]) => `${link(tasteTitle(k), TASTE_NAMES[k] ?? k)} ${n}`).join(' · ')}` : ''
  }
  const subjectLine = (list: Shelved[]) => {
    const t = tally(list, (s) => s.tags.filter((x) => SUBJECT_TAGS.has(x)))
    return t.length ? `Subjects: ${t.map(([k, n]) => `#${k} ${n}`).join(' · ')}` : ''
  }
  const yearTable = (list: Shelved[]) => {
    const t = tally(list, (s) => [s.year]).sort((a, b) => b[0].localeCompare(a[0]))
    return ['| Year | Pictures |', '| --- | --- |', ...t.map(([y, n]) => `| ${y} | ${n.toLocaleString('en-US')} |`)].join('\n')
  }
  const section = (...parts: string[]) => ['## Library', '', ...parts.filter(Boolean).flatMap((p) => [p, ''])].join('\n').trimEnd() + '\n'

  const byType = new Map<string, Shelved[]>()
  for (const s of shelved) {
    const list = byType.get(s.type)
    if (list) list.push(s)
    else byType.set(s.type, [s])
  }
  const types = [...byType].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

  // The hub.
  notes.push({
    path: `${lib}.md`,
    title: hubTitle,
    tags: ['library', 'pictures'],
    intro: `The picture library the librarian sorted from ${info.source}, by type, genre and year. The pictures are copies: the originals stay where they were. Open this star's gallery with ⇧G to see all of them around it.`,
    section: section(
      `${line(shelved)} · sorted from \`${info.source}\` on ${info.day}`,
      '### Types',
      types
        .map(([t, list]) => {
          const genres = tally(list, (s) => (s.genre ? [s.genre] : []))
          const sub = genres.length ? ` (${genres.map(([g, n]) => `${g} ${n}`).join(' · ')})` : ''
          return `- ${link(typeTitle(t), t)}: ${count(list.length, 'picture')}${sub}`
        })
        .join('\n'),
      '### Taste',
      tally(shelved, (s) => s.tags.filter((x) => x in TASTE_NAMES))
        .map(([k, n]) => `- ${link(tasteTitle(k), TASTE_NAMES[k] ?? k)}: ${count(n, 'picture')}`)
        .join('\n') || 'No colours measured yet.',
      '### Years',
      yearTable(shelved),
    ),
  })

  for (const [t, list] of types) {
    const folder = safeName(t)
    const genres = [...new Set(list.map((s) => s.genre).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b))
    notes.push({
      path: `${folder}/${folder}.md`,
      title: typeTitle(t),
      tags: ['library', tagOf(t)],
      intro: `${t} in the ${link(hubTitle, lib)} library.`,
      section: section(
        `${line(list)} · part of ${link(hubTitle, lib)}`,
        genres.length
          ? ['### Genres', genres.map((g) => `- ${link(genreTitle(t, g), g)}: ${count(list.filter((s) => s.genre === g).length, 'picture')}`).join('\n')].join('\n')
          : '',
        tasteLine(list),
        subjectLine(list),
        yearTable(list),
        '### Newest',
        samples(list, folder),
      ),
    })
    for (const g of genres) {
      const glist = list.filter((s) => s.genre === g)
      const gfolder = `${folder}/${safeName(g)}`
      const topTaste = tally(glist, (s) => s.tags.filter((x) => x in TASTE_NAMES))
        .slice(0, 3)
        .map(([k]) => k)
      notes.push({
        path: `${gfolder}/${safeName(g)}.md`,
        title: genreTitle(t, g),
        tags: ['library', tagOf(t), tagOf(g), ...topTaste].filter((x, i, a) => x && a.indexOf(x) === i),
        intro: `${g} ${t.toLowerCase()} in the ${link(hubTitle, lib)} library.`,
        section: section(
          `${line(glist)} · part of ${link(typeTitle(t), t)}`,
          tasteLine(glist),
          subjectLine(glist),
          yearTable(glist),
          '### Newest',
          samples(glist, gfolder),
        ),
      })
    }
  }

  for (const [k, n] of tally(shelved, (s) => s.tags.filter((x) => x in TASTE_NAMES))) {
    const list = shelved.filter((s) => s.tags.includes(k))
    const name = TASTE_NAMES[k] ?? k
    const folder = TASTE_FOLDER
    notes.push({
      path: `${folder}/${safeName(name)}.md`,
      title: tasteTitle(k),
      tags: ['library', 'taste', k],
      intro: `Pictures of the ${link(hubTitle, lib)} library whose colours feel ${name.toLowerCase()}. They stay in their type and genre folders; this note gathers them.`,
      section: section(
        `${count(n, 'picture')} · part of ${link(hubTitle, lib)}`,
        `By type: ${tally(list, (s) => [s.type])
          .map(([t, c]) => `${link(typeTitle(t), t)} ${c}`)
          .join(' · ')}`,
        '### Newest',
        samples(list, folder),
      ),
    })
  }
  return notes
}

/** A new index note: frontmatter, title, intro, then its Library section. */
export function newNote(n: LibraryNote, day: string): string {
  const yamlString = (s: string) => (/^[\w .·&()'-]+$/.test(s) && !/^[\s-]/.test(s) ? s : JSON.stringify(s))
  return [
    '---',
    `title: ${yamlString(n.title)}`,
    `tags: [${n.tags.join(', ')}]`,
    ...(n.path.split('/').length === 1 ? ['type: project'] : []),
    `created: ${day}`,
    `updated: ${day}`,
    '---',
    '',
    `# ${n.title}`,
    '',
    n.intro,
    '',
    n.section,
  ].join('\n')
}

const FENCE = /^\s*(```|~~~)/

/**
 * `existing` with its `## Library` section replaced by `section` (up to the
 * next `##` heading or the end; appended when there is none) and its
 * `updated:` date moved to `day`. Everything else is the user's and stays.
 */
export function mergeNote(existing: string, section: string, day: string): string {
  const lines = existing.split(/\r?\n/)
  let start = -1
  let end = lines.length
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (FENCE.test(l)) fenced = !fenced
    if (fenced) continue
    if (start < 0 && /^##\s+Library\s*$/.test(l)) start = i
    else if (start >= 0 && /^##\s/.test(l)) {
      end = i
      break
    }
  }
  const body = section.replace(/\n+$/, '').split('\n')
  let out: string[]
  if (start < 0) out = [...lines.join('\n').replace(/\s+$/, '').split('\n'), '', ...body, '']
  else out = [...lines.slice(0, start), ...body, ...(end < lines.length ? ['', ...lines.slice(end)] : [''])]
  let text = out.join('\n')
  // Only the frontmatter's own `updated:` line.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (fm) {
    const head = fm[1]!.replace(/^updated:.*$/m, `updated: ${day}`)
    text = `---\n${head}\n---${fm[2]}` + text.slice(fm[0].length)
  }
  return text
}
