/**
 * The notes the brain keeps about its user, as plain markdown in `Me/`:
 *   - `About me` — what the user asked the companion to remember, one section per area;
 *   - `Check-ins/Check-ins YYYY-MM` — one table row per check-in (mood, sleep, …);
 *   - `Wellbeing playbook` — the research the companion rests on, for the user to read and fill in;
 *   - `Chats/` — the conversations held in the brain's chat (see Brain.saveBrainChat).
 * Pure: building and reading those notes, and the trends of the check-ins.
 * Dates are the user's local ones (a check-in at 23:30 belongs to that day).
 */
import { PLAYBOOK_BODY, PLAYBOOK_TITLE } from './companion.js'

/** The Me folder (under the vault's home prefix). */
export const ME_FOLDER = 'Me'
export const ABOUT_ME_TITLE = 'About me'
export const CHECKINS_FOLDER = 'Check-ins'
export const CHATS_FOLDER = 'Chats'

/** Areas the companion remembers, by key (the tools' enum) → section heading in About me. */
export const ABOUT_ME_SECTIONS = {
  identity: 'Who I am',
  style: 'How I like to be talked to',
  values: 'What matters to me',
  strengths: 'Strengths',
  family: 'Family and the people I love',
  health: 'Health and routine',
  work: 'Work and art',
  goals: 'Goals',
  helps: 'What helps me',
  warning_signs: 'Early warning signs',
  support: 'My care team and people to call',
} as const

export type AboutMeArea = keyof typeof ABOUT_ME_SECTIONS
export const ABOUT_ME_AREAS = Object.keys(ABOUT_ME_SECTIONS) as AboutMeArea[]

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD` of `d` in local time. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `HH:MM` of `d` in local time. */
export function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `YYYY-MM` of `d` in local time: the month a check-in is filed under. */
export function localMonth(d: Date): string {
  return localDay(d).slice(0, 7)
}

/** A new About me note: one empty section per area. */
export function aboutMeNote(today: string): string {
  const sections = Object.values(ABOUT_ME_SECTIONS)
    .map((h) => `## ${h}\n`)
    .join('\n')
  return `---
title: ${ABOUT_ME_TITLE}
tags: [me]
created: ${today}
updated: ${today}
---

# ${ABOUT_ME_TITLE}

What I want my brain's companion to know about me. I can change anything here; the companion adds to it only when I say yes.

${sections}`
}

/** The Wellbeing playbook note. */
export function playbookNote(today: string): string {
  return `---
title: ${PLAYBOOK_TITLE}
tags: [me, wellbeing]
created: ${today}
updated: ${today}
---

${PLAYBOOK_BODY}
`
}

/** One check-in, as the check_in tool takes it (every field but mood optional). */
export interface CheckIn {
  /** 1–10. */
  mood: number
  /** Hours slept last night. */
  sleep?: number
  /** 1–10. */
  energy?: number
  /** 1–10. */
  stress?: number
  /** Medication taken as planned today (only for people who track it). */
  meds?: boolean
  /** Connection with family today, in their words. */
  family?: string
  win?: string
  worry?: string
  note?: string
}

/** A check-in read back from a note. */
export interface CheckInRow extends CheckIn {
  date: string
  time: string
}

const COLUMNS = ['Date', 'Time', 'Mood', 'Sleep', 'Energy', 'Stress', 'Meds', 'Family', 'Win', 'Worry', 'Note']

/** Title (and file name) of the check-in note for `month` (`YYYY-MM`). */
export function checkInTitle(month: string): string {
  return `Check-ins ${month}`
}

/** A new month's check-in note: a heading and the table header. */
export function checkInNote(month: string, today: string): string {
  return `---
title: ${checkInTitle(month)}
tags: [me, check-in]
created: ${today}
updated: ${today}
---

# ${checkInTitle(month)}

| ${COLUMNS.join(' | ')} |
| ${COLUMNS.map(() => '---').join(' | ')} |
`
}

/** A table cell: one line, `|` escaped, at most `max` characters. */
function cell(text: string | undefined, max = 300): string {
  if (!text) return ''
  const one = text.replace(/\s+/g, ' ').trim()
  const cut = one.length > max ? `${one.slice(0, max - 1)}…` : one
  return cut.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

const num = (n: number | undefined): string => (n === undefined || !Number.isFinite(n) ? '' : String(Math.round(n * 10) / 10))

/** The table row of one check-in made at `at`. */
export function checkInRow(c: CheckIn, at: Date): string {
  const meds = c.meds === undefined ? '' : c.meds ? 'yes' : 'no'
  const cells = [localDay(at), localTime(at), num(c.mood), num(c.sleep), num(c.energy), num(c.stress), meds, cell(c.family), cell(c.win), cell(c.worry), cell(c.note)]
  return `| ${cells.join(' | ')} |`
}

/** The cells of a table row, unescaped (`\|` is a pipe inside a cell). */
function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch === '\\' && i + 1 < inner.length) {
      cur += inner[++i]
    } else if (ch === '|') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

const numberOf = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : undefined
}

/** Every check-in row of a check-in note (rows whose first cell is a date), in file order. */
export function parseCheckIns(raw: string): CheckInRow[] {
  const out: CheckInRow[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!/^\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue
    const c = cellsOf(line)
    const mood = numberOf(c[2])
    if (mood === undefined) continue
    const row: CheckInRow = { date: c[0] ?? '', time: c[1] ?? '', mood }
    const sleep = numberOf(c[3])
    const energy = numberOf(c[4])
    const stress = numberOf(c[5])
    if (sleep !== undefined) row.sleep = sleep
    if (energy !== undefined) row.energy = energy
    if (stress !== undefined) row.stress = stress
    const meds = (c[6] ?? '').toLowerCase()
    if (meds === 'yes' || meds === 'no') row.meds = meds === 'yes'
    if (c[7]) row.family = c[7]
    if (c[8]) row.win = c[8]
    if (c[9]) row.worry = c[9]
    if (c[10]) row.note = c[10]
    out.push(row)
  }
  return out
}

export interface Averages {
  mood: number | null
  sleep: number | null
  energy: number | null
  stress: number | null
  count: number
}

export interface Trends {
  days: number
  /** Check-ins in the window. */
  count: number
  /** Date of the latest check-in ever seen, or null. */
  last: string | null
  /** Days since that check-in (0 today), or null. */
  daysSinceLast: number | null
  /** The last 7 days of the window. */
  recent: Averages
  /** The rest of the window before them (null when the window is 7 days or less). */
  before: Averages | null
  meds: { taken: number; missed: number }
  /** Shifts worth a gentle word, stated as facts. */
  notices: string[]
  /** The window's check-ins, newest first (at most 30). */
  rows: CheckInRow[]
}

const DAY_MS = 86_400_000

/** Whole days from `a` to `b` (`YYYY-MM-DD`, local calendar days). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / DAY_MS)
}

function average(rows: CheckInRow[]): Averages {
  const avg = (pick: (r: CheckInRow) => number | undefined): number | null => {
    const v = rows.map(pick).filter((x): x is number => x !== undefined)
    return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null
  }
  return { mood: avg((r) => r.mood), sleep: avg((r) => r.sleep), energy: avg((r) => r.energy), stress: avg((r) => r.stress), count: rows.length }
}

/**
 * Trends of the check-ins over the last `days` (7–90) up to `today`: the
 * last week against the weeks before it, medication taken or missed, and
 * plain-fact notices when sleep, mood or stress moved (never a conclusion;
 * the companion asks).
 */
export function checkInTrends(all: CheckInRow[], today: string, days = 14): Trends {
  const window = Math.min(90, Math.max(7, Math.round(days)))
  const sorted = [...all].sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1))
  const inWindow = sorted.filter((r) => {
    const ago = daysBetween(r.date, today)
    return ago >= 0 && ago < window
  })
  const recentRows = inWindow.filter((r) => daysBetween(r.date, today) < 7)
  const beforeRows = inWindow.filter((r) => daysBetween(r.date, today) >= 7)
  const recent = average(recentRows)
  const before = window > 7 ? average(beforeRows) : null
  const meds = { taken: recentRows.filter((r) => r.meds === true).length, missed: recentRows.filter((r) => r.meds === false).length }
  const last = sorted[0]?.date ?? null
  const daysSinceLast = last ? Math.max(0, daysBetween(last, today)) : null
  const notices: string[] = []
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  if (recent.sleep !== null && recentRows.filter((r) => r.sleep !== undefined).length >= 3 && recent.sleep < 6) {
    notices.push(`Sleep has averaged ${f(recent.sleep)} h over the last week's check-ins.`)
  }
  if (before && before.count >= 2 && recent.count >= 2) {
    if (recent.sleep !== null && before.sleep !== null && before.sleep - recent.sleep >= 1.5) notices.push(`Sleep is down from about ${f(before.sleep)} h to ${f(recent.sleep)} h.`)
    if (before.mood !== null && recent.mood !== null && before.mood - recent.mood >= 2) notices.push(`Mood is down from about ${f(before.mood)} to ${f(recent.mood)}.`)
    if (before.stress !== null && recent.stress !== null && recent.stress - before.stress >= 2) notices.push(`Stress is up from about ${f(before.stress)} to ${f(recent.stress)}.`)
  }
  if (meds.missed >= 2) notices.push(`Medication was marked not taken on ${meds.missed} days this week.`)
  if (daysSinceLast !== null && daysSinceLast >= 5) notices.push(`The last check-in was ${daysSinceLast} days ago.`)
  return { days: window, count: inWindow.length, last, daysSinceLast, recent, before, meds, notices, rows: inWindow.slice(0, 30) }
}

/**
 * A remembered fact as a bullet of About me: one line, dated, never a task
 * (`[ ] …` would become one) and never a heading.
 */
export function factLine(fact: string, today: string): string {
  let one = fact.replace(/\s+/g, ' ').trim()
  if (one.length > 500) one = `${one.slice(0, 499)}…`
  one = one.replace(/^[-*+]\s+/, '').replace(/^\[([ xX])\]/, '\\[$1]').replace(/^#/, '\\#')
  return `- ${one} _(${today})_`
}

/** The sections of About me that hold nothing yet (by heading). */
export function emptySections(raw: string): string[] {
  const out: string[] = []
  const lines = raw.split(/\r?\n/)
  for (const heading of Object.values(ABOUT_ME_SECTIONS)) {
    const i = lines.findIndex((l) => l.replace(/^#+\s*/, '').trim().toLowerCase() === heading.toLowerCase() && /^#{1,6}\s/.test(l))
    if (i < 0) {
      out.push(heading)
      continue
    }
    let has = false
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j] ?? ''); j++) if ((lines[j] ?? '').trim()) has = true
    if (!has) out.push(heading)
  }
  return out
}
