import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPANION_GUIDE } from '../src/mcp/companion.js'
import {
  DAY_PROMPTS,
  NUDGE_KINDS,
  NUDGE_TEXT,
  NUDGE_WINDOWS,
  QUIET_MS,
  SNOOZE_MS,
  answered,
  emptyRecord,
  nextNudge,
  readRecord,
  type NudgeContext,
  type NudgeKind,
} from '../src/renderer/nudges'
import { lf } from './lf'

/**
 * The day-planning nudges (docs/BRAIN-CHAT.md, "Plan my day, and the quiet cards"): when each card may show, what it says, how
 * the chat carries the day's conversation, and that the documents and the coach's guide say what the code does.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A local time on a day in October 2026 (the tests run in UTC). */
const at = (h: number, m = 0, day = 17): Date => new Date(2026, 9, day, h, m)
const ready: NudgeContext = { on: true, ready: true, open: 3, here: true, occupied: false }
const fresh = (day = 17) => emptyRecord(`2026-10-${day}`)

describe('when a card may show', () => {
  it('offers the morning card from 05:00, the check-in from 14:00 and the wrap-up from 18:00, and nothing between', () => {
    const cases: [number, number, NudgeKind | null][] = [
      [4, 59, null],
      [5, 0, 'morning'],
      [11, 59, 'morning'],
      [12, 0, null],
      [13, 59, null],
      [14, 0, 'afternoon'],
      [17, 29, 'afternoon'],
      [17, 30, null],
      [17, 59, null],
      [18, 0, 'evening'],
      [21, 29, 'evening'],
      [21, 30, null],
      [23, 30, null],
      [0, 10, null],
    ]
    for (const [h, m, want] of cases) expect(nextNudge(at(h, m), fresh(), ready), `${h}:${m}`).toBe(want)
  })

  it('waits for everything it needs: the setting, a chat that is set up, something on today, the window in front, nobody busy', () => {
    for (const off of [{ on: false }, { ready: false }, { open: 0 }, { here: false }, { occupied: true }]) {
      expect(nextNudge(at(9), fresh(), { ...ready, ...off }), JSON.stringify(off)).toBeNull()
    }
    expect(nextNudge(at(9), fresh(), ready)).toBe('morning')
  })

  it('is over for the day once it was taken up or skipped, and only that card', () => {
    const now = at(9).getTime()
    for (const how of ['start', 'skip'] as const) {
      const record = answered(fresh(), 'morning', how, now)
      expect(nextNudge(at(9, 30), record, ready), how).toBeNull()
      expect(nextNudge(at(15), record, ready), how).toBe('afternoon')
      expect(nextNudge(at(19), record, ready), how).toBe('evening')
    }
    // Answering twice keeps one entry.
    expect(answered(answered(fresh(), 'morning', 'skip', now), 'morning', 'start', now).over).toEqual(['morning'])
  })

  it('puts a card off for an hour on "later", and brings it back after, while its window is open', () => {
    const record = answered(fresh(), 'morning', 'later', at(9, 0).getTime())
    expect(nextNudge(at(9, 1), record, ready)).toBeNull()
    expect(nextNudge(at(9, 59), record, ready)).toBeNull()
    expect(nextNudge(at(10, 0), record, ready)).toBe('morning')
    // Put off past the end of its window, it does not come back that day.
    const late = answered(fresh(), 'morning', 'later', at(11, 30).getTime())
    expect(nextNudge(at(12, 30), late, ready)).toBeNull()
    expect(SNOOZE_MS).toBe(60 * 60 * 1000)
  })

  it('starts every day fresh: the record of another day counts for nothing', () => {
    const yesterday = answered(fresh(16), 'morning', 'skip', at(9, 0, 16).getTime())
    expect(nextNudge(at(9, 0, 17), yesterday, ready)).toBe('morning')
  })

  it('keeps its windows in order and apart, so one card at a time', () => {
    let last = -1
    for (const kind of NUDGE_KINDS) {
      const { from, to } = NUDGE_WINDOWS[kind]
      expect(from).toBeGreaterThan(last)
      expect(to).toBeGreaterThan(from)
      last = to
    }
  })
})

describe('the day’s record', () => {
  it('is read back repaired: another day’s, garbage, unknown kinds and numbers that are not numbers all go', () => {
    expect(readRecord(null, '2026-10-17')).toEqual(emptyRecord('2026-10-17'))
    expect(readRecord('no', '2026-10-17')).toEqual(emptyRecord('2026-10-17'))
    expect(readRecord({ day: '2026-10-16', over: ['morning'], snoozed: {} }, '2026-10-17')).toEqual(emptyRecord('2026-10-17'))
    const kept = readRecord({ day: '2026-10-17', over: ['morning', 'noon', 7], snoozed: { evening: 123, afternoon: 'x', morning: NaN, noon: 5 } }, '2026-10-17')
    expect(kept).toEqual({ day: '2026-10-17', over: ['morning'], snoozed: { evening: 123 } })
  })

  it('is never changed in place by an answer', () => {
    const before = fresh()
    const copy = JSON.stringify(before)
    answered(before, 'evening', 'start', 1)
    answered(before, 'evening', 'later', 1)
    expect(JSON.stringify(before)).toBe(copy)
  })
})

describe('what a card says', () => {
  it('has no number in it, and nothing about what is late: it is a kind offer, not a count', () => {
    for (const kind of NUDGE_KINDS) {
      const t = NUDGE_TEXT[kind]
      for (const text of [t.title, t.body, t.action]) {
        expect(text, `${kind}: ${text}`).not.toMatch(/\d/)
        expect(text, `${kind}: ${text}`).not.toMatch(/late|overdue|behind|missed|failed|should/i)
      }
    }
  })

  it('renders the card with its buttons and a quiet role, still without a number', async () => {
    const { NudgeView } = await import('../src/renderer/components/NudgeCard')
    const noop = () => undefined
    /** As the markup writes it (an apostrophe becomes &#x27;). */
    const escaped = (s: string): string => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    for (const kind of NUDGE_KINDS) {
      const html = renderToStaticMarkup(createElement(NudgeView, { kind, onStart: noop, onLater: noop, onSkip: noop, onOff: noop }))
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
      expect(html).toContain('role="status"')
      expect(text).toContain(NUDGE_TEXT[kind].title)
      expect(text).toContain(escaped(NUDGE_TEXT[kind].body))
      expect(text).toContain(NUDGE_TEXT[kind].action)
      expect(text).toContain('In an hour')
      expect(text).toContain('Turn nudges off')
      expect(html).toContain('aria-label="Not today"')
      // (&#x27; is an apostrophe, written with digits.)
      expect(text.replace(/&#x27;/g, "'")).not.toMatch(/\d/)
      expect(html).not.toMatch(/autofocus|<audio|autoplay/i)
    }
  })
})

describe('the chat and the coach', () => {
  it('asks in the words the coach’s guide knows how to answer', () => {
    const day = COMPANION_GUIDE.split('## The day')[1]?.split('\n## ')[0] ?? ''
    expect(day).not.toBe('')
    expect(DAY_PROMPTS.morning.startsWith('Plan my day with me')).toBe(true)
    expect(DAY_PROMPTS.afternoon.startsWith('Check in on my day with me')).toBe(true)
    expect(DAY_PROMPTS.evening.startsWith('Help me wrap up my day')).toBe(true)
    for (const quoted of ['"Plan my day with me"', '"Check in on my day with me"', '"Help me wrap up my day"']) expect(day).toContain(quoted)
    // For anyone who asks, ADHD or not, with the care for counts and guilt the cards have.
    expect(day).toMatch(/for anyone who asks/)
    expect(day).toMatch(/don't say how many things there are or how much is late/)
    expect(day).toMatch(/Afternoon check-in/)
    expect(day).toMatch(/End of day/)
    expect(day).toMatch(/No guilt/)
  })
})

describe('the documents', () => {
  const doc = lf(readFileSync(new URL('../../../docs/BRAIN-CHAT.md', import.meta.url), 'utf8'))
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

  it('says when each card shows, as the code has it', () => {
    for (const kind of NUDGE_KINDS) {
      const { title, action } = NUDGE_TEXT[kind]
      const { from, to } = NUDGE_WINDOWS[kind]
      expect(doc, kind).toContain(`| ${title} | *${action}* | ${hhmm(from)} and ${hhmm(to)} |`)
    }
  })

  it('says what a card does when left alone or put off, as the code has it', () => {
    expect(QUIET_MS).toBe(2 * 60 * 1000)
    expect(doc).toContain('left alone for two minutes it goes away by itself and comes back in an hour')
    expect(doc).toContain('*In an hour*')
    expect(doc).toContain('No sound, never the keyboard')
    expect(doc).toContain('there is no card for "something is due within the hour"')
  })
})

/* ------------------------------------------------------------------ */
/* The chat panel with a fake bridge                                   */
/* ------------------------------------------------------------------ */

/** The chat panel module with a bridge that records what it is asked, in a fresh module state. */
async function panel() {
  vi.resetModules()
  const calls = { send: [] as [string, string][], forget: [] as string[], configure: [] as { nudges?: boolean }[] }
  let feed: ((e: unknown) => void) | null = null
  let status = {
    provider: 'claude',
    claudeModel: 'claude-opus-5-5',
    claudeModels: [],
    hasKey: true,
    keyHint: '…WXYZ',
    keyStored: 'encrypted',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    saveChats: true,
    nudges: true,
    vaultOpen: true,
    ready: true,
    missing: null,
  }
  const bridge = {
    chatStatus: async () => status,
    chatConfigure: async (patch: { nudges?: boolean }) => {
      calls.configure.push(patch)
      status = { ...status, ...patch }
      return status
    },
    chatSend: async (conv: string, text: string) => {
      calls.send.push([conv, text])
      return { text: '', stop: 'end_turn', saved: null }
    },
    chatForget: async (conv: string) => void calls.forget.push(conv),
    chatStop: async () => undefined,
    onChatEvent: (cb: (e: unknown) => void) => {
      feed = cb
      return () => undefined
    },
  }
  vi.stubGlobal('window', { aether: bridge, addEventListener: () => undefined, removeEventListener: () => undefined })
  const chat = await import('../src/renderer/components/ChatPanel')
  const ui = await import('@aether/ui')
  const commands = await import('../../../packages/ui/src/commands')
  chat.registerChat()
  /** The model finishes answering `conv` (the panel is busy until it does). */
  const finish = () => {
    const conv = calls.send.at(-1)![0]
    feed!({ conv, type: 'done', text: '', stop: 'end_turn' })
  }
  const nudges = await import('../src/renderer/nudges')
  return { chat, ui, commands, calls, finish, nudges }
}

describe('Plan my day in the chat', () => {
  it('sends the prompt of its time of day and counts that as taking the card up', async () => {
    vi.useFakeTimers({ now: at(9, 0), toFake: ['Date'] })
    const { chat, calls, nudges } = await panel()
    chat.sendDayPrompt('morning')
    await vi.waitFor(() => expect(calls.send).toHaveLength(1))
    expect(calls.send[0]![1]).toBe(DAY_PROMPTS.morning)
    expect(nudges.currentRecord(at(9, 0)).over).toEqual(['morning'])
    // So the morning card has nothing left to say today, but the others do.
    expect(nudges.nextNudge(at(9, 30), nudges.currentRecord(at(9, 30)), ready)).toBeNull()
    expect(nudges.nextNudge(at(15), nudges.currentRecord(at(15)), ready)).toBe('afternoon')
  })

  it('goes on in today’s conversation, and starts a new one when the open one is from another day', async () => {
    vi.useFakeTimers({ now: at(9, 0), toFake: ['Date'] })
    const { chat, calls, finish } = await panel()
    chat.sendDayPrompt('morning')
    await vi.waitFor(() => expect(calls.send).toHaveLength(1))
    finish()
    // The afternoon check-in goes on in the same conversation: it knows the morning's plan.
    vi.setSystemTime(at(15, 0))
    chat.sendDayPrompt('afternoon')
    await vi.waitFor(() => expect(calls.send).toHaveLength(2))
    expect(calls.send[1]![0]).toBe(calls.send[0]![0])
    expect(calls.send[1]![1]).toBe(DAY_PROMPTS.afternoon)
    expect(calls.forget).toEqual([])
    finish()
    // Next morning the conversation left open is yesterday's: a new one, and the old one is let go.
    vi.setSystemTime(at(9, 0, 18))
    chat.sendDayPrompt('morning')
    await vi.waitFor(() => expect(calls.send).toHaveLength(3))
    expect(calls.send[2]![0]).not.toBe(calls.send[0]![0])
    expect(calls.forget).toEqual([calls.send[0]![0]])
  })

  it('has a palette command for each of the three, and one for the nudges switch', async () => {
    vi.useFakeTimers({ now: at(9, 0), toFake: ['Date'] })
    const { ui, commands, calls, finish } = await panel()
    const find = () => commands.findCommands('', ui.useAether.getState())
    const byId = (id: string) => find().find((c) => c.id === id)
    const titles = { 'chat-plan-day': 'Plan my day with your brain', 'chat-check-day': 'Check in on my day with your brain', 'chat-wrap-day': 'Wrap up my day with your brain' }
    for (const [id, title] of Object.entries(titles)) {
      expect(byId(id)?.title, id).toBe(title)
      // The chat's document lists it by that name.
      expect(lf(readFileSync(new URL('../../../docs/BRAIN-CHAT.md', import.meta.url), 'utf8')), id).toContain(`*${title}*`)
    }
    expect(byId('nudges')?.title).toMatch(/^Nudges: /)
    expect(lf(readFileSync(new URL('../../../docs/BRAIN-CHAT.md', import.meta.url), 'utf8'))).toContain('*Nudges*')
    // Running one sends its prompt.
    byId('chat-wrap-day')!.run(ui.useAether.getState())
    await vi.waitFor(() => expect(calls.send).toHaveLength(1))
    expect(calls.send[0]![1]).toBe(DAY_PROMPTS.evening)
    finish()
  })

  it('turns the nudges off and on from the palette, and says so', async () => {
    const { chat, ui, calls } = await panel()
    await chat.setNudges()
    expect(calls.configure).toEqual([{ nudges: false }])
    expect(ui.useAether.getState().toasts.at(-1)?.text).toBe('Nudges off')
    await chat.setNudges()
    expect(calls.configure.at(-1)).toEqual({ nudges: true })
    expect(ui.useAether.getState().toasts.at(-1)?.text).toMatch(/Nudges on/)
    await chat.setNudges(true)
    expect(calls.configure.at(-1)).toEqual({ nudges: true })
  })
})
