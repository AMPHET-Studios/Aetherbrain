/**
 * A graded drawing as a plain markdown note (the Concept Forge link). The
 * drawing is saved next to it as a PNG and embedded with `![[file.png]]`; the
 * grade is written as readable text plus Dataview inline fields
 * (`grade:: B+`, `score:: 82`), so no new frontmatter keys are invented. The
 * fixes become tasks, and the biggest one can be due tomorrow so it shows up
 * on the next daily brief.
 */
import { joinFrontmatter } from './frontmatter'
import { slugifyTitle, todayIso } from '../vault/paths'

export interface CritiqueScore {
  label: string
  /** 0–100. */
  score: number
  note?: string
}

export interface CritiqueInput {
  /** What was drawn or drilled, e.g. "Gesture Warm-Up". */
  title: string
  /** Project the critique belongs to (linked as [[title]]). */
  project?: string | null
  drill?: string | null
  /** Letter grade, e.g. "B+". */
  grade?: string | null
  /** Overall score, 0–100. */
  score?: number | null
  scores?: CritiqueScore[]
  /** Biggest opportunities first. */
  fixes?: string[]
  strengths?: string[]
  /** Written critique (markdown), e.g. from Concept Forge's Deep Critique. */
  deep?: string | null
  /** Where the drawing came from (default "Concept Forge"). */
  source?: string
}

export interface CritiqueNoteOptions {
  /** Day of the critique (default today, local time). */
  date?: string
  /** Due date for the first fix (a practice task on that day's brief), or null for none. */
  practiceDue?: string | null
}

/** Caps on what a critique note takes in (the fields can come from any page). */
const MAX_TITLE = 120
const MAX_ITEMS = 20
const MAX_ITEM = 400
const MAX_DEEP = 20_000

/** One line of plain text: no line breaks, no leading list/heading markers, trimmed and capped. */
function oneLine(text: unknown, max = MAX_ITEM): string {
  return String(text ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^([-*+>#]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .slice(0, max)
    .trim()
}

/** A letter grade as written by graders (`A+`, `B`, `C-`), or null. */
export function cleanGrade(grade: unknown): string | null {
  const g = oneLine(grade, 3).toUpperCase()
  return /^[A-F][+-]?$/.test(g) ? g : null
}

/** A score in 0–100 (a 0–1 fraction is scaled), rounded, or null. */
export function cleanScore(score: unknown): number | null {
  const n = typeof score === 'number' ? score : typeof score === 'string' ? Number(score.trim()) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  const v = n <= 1 && n > 0 && !Number.isInteger(n) ? n * 100 : n
  return v > 100 ? null : Math.round(v)
}

/**
 * File name (no extension) for a critique of `title` on `date`:
 * `2026-09-30 Gesture Warm-Up`. Safe on every OS.
 */
export function critiqueBaseName(title: string, date = todayIso()): string {
  const name = slugifyTitle(oneLine(title, MAX_TITLE)).replace(/[. ]+$/, '')
  return `${date} ${name || 'Drawing'}`
}

/** Quote a block of markdown (every line behind `> `), so it can't start headings or tasks of the note. */
function quote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
}

/** Markdown table cell text: pipes escaped, one line. */
function cell(text: string): string {
  return oneLine(text, 200).replace(/\|/g, '\\|')
}

/** The note for a graded drawing saved as `imageFile` (a file name next to the note). */
export function critiqueNote(input: CritiqueInput, imageFile: string, opts: CritiqueNoteOptions = {}): string {
  const date = opts.date ?? todayIso()
  const title = oneLine(input.title, MAX_TITLE) || 'Drawing'
  const drill = input.drill ? oneLine(input.drill, 60) : ''
  const grade = cleanGrade(input.grade)
  const score = cleanScore(input.score)
  const project = input.project ? oneLine(input.project, MAX_TITLE).replace(/[[\]|#^]/g, '') : ''
  const source = oneLine(input.source ?? 'Concept Forge', 60) || 'Concept Forge'
  const drillTag = drill
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const tags = ['critique', 'concept-forge', ...(drillTag ? [`drill/${drillTag}`] : [])]
  const fm: Record<string, unknown> = { title: `${title} — ${date}`, tags, created: date, updated: date }

  const out: string[] = [`# ${title} — ${date}`, '', `![[${imageFile.replace(/[[\]|]/g, '')}]]`, '']
  const facts: string[] = []
  if (grade || score !== null) facts.push(`Grade **${[grade, score !== null ? `${score}/100` : ''].filter(Boolean).join(' · ')}**`)
  if (drill) facts.push(`Drill: ${drill}`)
  if (project) facts.push(`Project: [[${project}]]`)
  facts.push(`Source: ${source}`)
  out.push(facts.join(' · '), '')
  if (grade) out.push(`grade:: ${grade}`)
  if (score !== null) out.push(`score:: ${score}`)
  if (grade || score !== null) out.push('')

  const scores = (input.scores ?? [])
    .slice(0, MAX_ITEMS)
    .map((s) => ({ label: cell(s.label), score: cleanScore(s.score), note: s.note ? cell(s.note) : '' }))
    .filter((s) => s.label && s.score !== null)
  if (scores.length) {
    const withNotes = scores.some((s) => s.note)
    out.push('## Scores', '', withNotes ? '| Criterion | Score | Note |' : '| Criterion | Score |', withNotes ? '| --- | ---: | --- |' : '| --- | ---: |')
    for (const s of scores) out.push(withNotes ? `| ${s.label} | ${s.score} | ${s.note} |` : `| ${s.label} | ${s.score} |`)
    out.push('')
  }

  const fixes = (input.fixes ?? []).map((f) => oneLine(f)).filter(Boolean).slice(0, MAX_ITEMS)
  if (fixes.length) {
    out.push('## Fix next', '')
    fixes.forEach((f, i) => out.push(`- [ ] ${f}${i === 0 && opts.practiceDue ? ` 📅 ${opts.practiceDue}` : ''}`))
    out.push('')
  }

  const strengths = (input.strengths ?? []).map((f) => oneLine(f)).filter(Boolean).slice(0, MAX_ITEMS)
  if (strengths.length) {
    out.push('## Working', '')
    for (const s of strengths) out.push(`- ${s}`)
    out.push('')
  }

  const deep = String(input.deep ?? '').trim().slice(0, MAX_DEEP)
  if (deep) out.push('## Deep critique', '', quote(deep), '')

  return joinFrontmatter(fm, `${out.join('\n').trimEnd()}\n`)
}

/** A grade as the brain keeps it: every field cleaned, possibly empty. */
export interface CritiqueGrade {
  grade: string | null
  score: number | null
  drill: string | null
  scores: CritiqueScore[]
  fixes: string[]
  strengths: string[]
  deep: string | null
}

const GRADE_KEYS = ['letter', 'lettergrade', 'gradeletter', 'grade', 'mark', 'rank']
const SCORE_KEYS = ['score', 'overall', 'total', 'totalscore', 'overallscore', 'percent', 'pct', 'points', 'value']
const DRILL_KEYS = ['drill', 'drillname', 'drilltitle', 'exercise', 'mode', 'category']
const SCORES_KEYS = ['breakdown', 'criteria', 'scores', 'rubric', 'categories', 'metrics', 'results', 'parts']
const FIX_KEYS = ['fixes', 'opportunities', 'improvements', 'improve', 'weaknesses', 'weak', 'weakest', 'tofix', 'nextsteps', 'next', 'advice', 'tips']
const STRENGTH_KEYS = ['strengths', 'working', 'strong', 'strongest', 'positives', 'wins', 'good', 'best']
const DEEP_KEYS = ['deep', 'deepcritique', 'critique', 'aicritique', 'ai', 'review', 'feedback', 'summary']
const LABEL_KEYS = ['label', 'name', 'criterion', 'title', 'key', 'id', 'area', 'category']
const ITEM_SCORE_KEYS = ['score', 'value', 'pct', 'percent', 'points', 'rating']
const NOTE_KEYS = ['note', 'tip', 'comment', 'feedback', 'detail', 'why', 'fix']
const TEXT_KEYS = ['fix', 'tip', 'advice', 'text', 'how', 'action', 'message', 'description', 'detail', 'note', 'label', 'title', 'name']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Value of the first of `keys` present on `obj` (keys compared lowercase, without `_` / `-`). */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const byKey = new Map<string, unknown>()
  for (const k of Object.keys(obj).slice(0, 200)) byKey.set(k.toLowerCase().replace(/[_-]/g, ''), obj[k])
  for (const k of keys) if (byKey.has(k)) return byKey.get(k)
  return undefined
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return oneLine(v)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (isRecord(v)) {
    const label = pick(v, ['label', 'name', 'title', 'criterion', 'area'])
    const body = pick(v, TEXT_KEYS.filter((k) => !['label', 'title', 'name'].includes(k)))
    const l = typeof label === 'string' ? oneLine(label) : ''
    const b = typeof body === 'string' ? oneLine(body) : ''
    if (l && b && !b.toLowerCase().startsWith(l.toLowerCase())) return oneLine(`${l}: ${b}`)
    return b || l
  }
  return ''
}

function listOf(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : isRecord(v) ? Object.values(v) : []
  return items
    .slice(0, MAX_ITEMS * 2)
    .map(textOf)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
}

function scoresOf(v: unknown): CritiqueScore[] {
  const out: CritiqueScore[] = []
  const push = (label: unknown, score: unknown, note?: unknown): void => {
    const l = typeof label === 'string' ? oneLine(label, 80) : ''
    const s = cleanScore(isRecord(score) ? pick(score, ITEM_SCORE_KEYS) : score)
    if (!l || s === null || out.length >= MAX_ITEMS) return
    const n = typeof note === 'string' ? oneLine(note, 200) : ''
    out.push(n ? { label: l, score: s, note: n } : { label: l, score: s })
  }
  if (Array.isArray(v)) {
    for (const item of v.slice(0, MAX_ITEMS * 2)) if (isRecord(item)) push(pick(item, LABEL_KEYS), pick(item, ITEM_SCORE_KEYS), pick(item, NOTE_KEYS))
  } else if (isRecord(v)) {
    for (const [k, item] of Object.entries(v).slice(0, MAX_ITEMS * 2)) {
      if (isRecord(item)) push(pick(item, LABEL_KEYS) ?? k, pick(item, ITEM_SCORE_KEYS), pick(item, NOTE_KEYS))
      else push(k, item)
    }
  }
  return out
}

/**
 * A grade object from any grader (Concept Forge's `lastGrade`, a saved grade
 * history entry…) read into a CritiqueGrade. Field names are matched loosely
 * (`letter` / `grade`, `score` / `overall`, `breakdown` / `criteria`,
 * `fixes` / `opportunities`, …), and one nested level (`{ grade: { … } }`,
 * `{ result: { … } }`) is looked into. Anything unreadable is left empty.
 */
export function normalizeGrade(raw: unknown): CritiqueGrade {
  const out: CritiqueGrade = { grade: null, score: null, drill: null, scores: [], fixes: [], strengths: [], deep: null }
  if (!isRecord(raw)) return out
  const layers: Record<string, unknown>[] = [raw]
  for (const v of Object.values(raw).slice(0, 50)) if (isRecord(v)) layers.push(v)
  for (const obj of layers) {
    if (out.grade === null) {
      const g = pick(obj, GRADE_KEYS)
      out.grade = typeof g === 'string' ? cleanGrade(g) : null
    }
    if (out.score === null) {
      const s = pick(obj, SCORE_KEYS)
      out.score = typeof s === 'number' || typeof s === 'string' ? cleanScore(s) : null
    }
    if (out.drill === null) {
      const d = pick(obj, DRILL_KEYS)
      const t = typeof d === 'string' ? oneLine(d, 60) : isRecord(d) ? textOf(d).slice(0, 60) : ''
      out.drill = t || null
    }
    if (!out.scores.length) out.scores = scoresOf(pick(obj, SCORES_KEYS))
    if (!out.fixes.length) out.fixes = listOf(pick(obj, FIX_KEYS))
    if (!out.strengths.length) out.strengths = listOf(pick(obj, STRENGTH_KEYS))
    if (out.deep === null) {
      const d = pick(obj, DEEP_KEYS)
      const t = typeof d === 'string' ? d.trim().slice(0, MAX_DEEP) : ''
      out.deep = t.length >= 20 ? t : null
    }
  }
  return out
}
