/**
 * Nudges: a quiet card that offers to plan the day in the morning, check in on it in the afternoon and wrap it up in the
 * evening (components/NudgeCard.tsx). Never a sound and never a number: a count of what is late is not a kind thing to put in
 * front of someone, and the coach is told the same (src/mcp/companion.ts). At most three a day, each once unless it is put
 * off, and only when the chat is set up and something is on today's brief. This file is the pure part: when each one may
 * show, what it says and what the day's record keeps.
 */
import { todayIso } from '@aether/core'

/** Plan the day, check in on it, wrap it up. */
export type NudgeKind = 'morning' | 'afternoon' | 'evening'
export const NUDGE_KINDS: readonly NudgeKind[] = ['morning', 'afternoon', 'evening']

/** When each one may show, in minutes after local midnight (from, inclusive; to, exclusive). */
export const NUDGE_WINDOWS: Readonly<Record<NudgeKind, { from: number; to: number }>> = {
  morning: { from: 5 * 60, to: 12 * 60 },
  afternoon: { from: 14 * 60, to: 17 * 60 + 30 },
  evening: { from: 18 * 60, to: 21 * 60 + 30 },
}

/** "In an hour". */
export const SNOOZE_MS = 60 * 60 * 1000
/** A card nobody answered goes away by itself after this, and comes back in an hour like a "later". */
export const QUIET_MS = 2 * 60 * 1000

/** What the card says. No number in any of it. */
export const NUDGE_TEXT: Readonly<Record<NudgeKind, { icon: string; title: string; body: string; action: string }>> = {
  morning: { icon: '☀', title: 'Good morning', body: 'Want to pick what matters today? It takes a couple of minutes.', action: 'Plan my day' },
  afternoon: { icon: '🌤', title: 'A check-in', body: "How's the day going? We can re-plan the rest, no guilt.", action: 'Check in' },
  evening: { icon: '🌙', title: 'Winding down', body: 'Want to wrap up: one win, one thing to carry over, then stop?', action: 'Wrap up' },
}

/** What the chat is asked, in the person's own voice (the coach guide's "The day" says how to answer each). */
export const DAY_PROMPTS: Readonly<Record<NudgeKind, string>> = {
  morning: "Plan my day with me. Look at what's on for today, pick at most three things with me, and help me start the first one.",
  afternoon: "Check in on my day with me: what's done and what's left? Help me re-plan the rest, no guilt.",
  evening: 'Help me wrap up my day: one win, one thing to carry over, and a clear stop.',
}

/** What was done with the nudges of one day. */
export interface NudgeRecord {
  /** The local day (YYYY-MM-DD) this is for. */
  day: string
  /** Over for today: started, or skipped. */
  over: NudgeKind[]
  /** Put off until (epoch ms). */
  snoozed: Partial<Record<NudgeKind, number>>
}

export function emptyRecord(day: string): NudgeRecord {
  return { day, over: [], snoozed: {} }
}

/** A saved record, repaired: another day's, or anything that is not a record, is a fresh one for `day`. */
export function readRecord(raw: unknown, day: string): NudgeRecord {
  if (!raw || typeof raw !== 'object') return emptyRecord(day)
  const r = raw as Record<string, unknown>
  if (r['day'] !== day) return emptyRecord(day)
  const out = emptyRecord(day)
  if (Array.isArray(r['over'])) out.over = NUDGE_KINDS.filter((k) => (r['over'] as unknown[]).includes(k))
  const snoozed = r['snoozed']
  if (snoozed && typeof snoozed === 'object') {
    for (const k of NUDGE_KINDS) {
      const v = (snoozed as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v)) out.snoozed[k] = v
    }
  }
  return out
}

/** `start`: the person took it up; `skip`: not today; `later`: in an hour (also what a card nobody answered counts as). */
export type NudgeAnswer = 'start' | 'skip' | 'later'

export function answered(record: NudgeRecord, kind: NudgeKind, how: NudgeAnswer, nowMs: number): NudgeRecord {
  if (how === 'later') return { ...record, snoozed: { ...record.snoozed, [kind]: nowMs + SNOOZE_MS } }
  return { ...record, over: record.over.includes(kind) ? record.over : [...record.over, kind] }
}

/** What decides whether a nudge may show right now. */
export interface NudgeContext {
  /** The setting: nudges are on. */
  on: boolean
  /** The chat is set up: with it not, the card would have nothing to open. */
  ready: boolean
  /** Open tasks on today's brief (overdue and today's): with none there is nothing to plan. */
  open: number
  /** The window is on screen and in front. */
  here: boolean
  /** Something else has the person's attention: the chat is open or answering, the palette or the cheatsheet is up, the boards are. */
  occupied: boolean
}

/** The nudge to show now, or null. The first of the day's windows that is open, not over and not put off. */
export function nextNudge(now: Date, record: NudgeRecord, ctx: NudgeContext): NudgeKind | null {
  if (!ctx.on || !ctx.ready || !ctx.here || ctx.occupied || ctx.open <= 0) return null
  const day = todayIso(now)
  const today = record.day === day ? record : emptyRecord(day)
  const minutes = now.getHours() * 60 + now.getMinutes()
  for (const kind of NUDGE_KINDS) {
    const { from, to } = NUDGE_WINDOWS[kind]
    if (minutes < from || minutes >= to) continue
    if (today.over.includes(kind)) continue
    if ((today.snoozed[kind] ?? 0) > now.getTime()) continue
    return kind
  }
  return null
}

/* ------------------------------------------------------------------ */
/* The day's record, kept in this window's storage                    */
/* ------------------------------------------------------------------ */

const KEY = 'aether:nudges'

function save(r: NudgeRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r))
  } catch {
    /* no storage: the record lives until the window closes */
  }
}

function load(day: string): NudgeRecord {
  try {
    return readRecord(JSON.parse(localStorage.getItem(KEY) ?? 'null'), day)
  } catch {
    return emptyRecord(day)
  }
}

let record: NudgeRecord | null = null

/** The record of the day `now` is in (a new day starts a fresh one). */
export function currentRecord(now: Date = new Date()): NudgeRecord {
  const day = todayIso(now)
  if (!record || record.day !== day) record = load(day)
  return record
}

/** Note how a nudge was answered; planning the day by any other way (the palette, a starter) counts as taking it up. */
export function answerNudge(kind: NudgeKind, how: NudgeAnswer, nowMs: number = Date.now()): void {
  record = answered(currentRecord(new Date(nowMs)), kind, how, nowMs)
  save(record)
}

/** Forget what the module has in memory (tests). */
export function resetNudgeRecord(): void {
  record = null
}
