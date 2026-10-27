import { describe, expect, it } from 'vitest'
import { parseNote, type NoteId, type ParsedNote } from '../src'
import { REMINDER_MAX, REMINDER_TAGGED_URGENCY, REMINDER_TEXT_MAX, remindersOf } from '../src/vault/reminders'

/** The reminders that float by as asteroids: dated tasks that are late or soon, and notes tagged `reminder`. */

const DAY = '2026-10-26'
function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

describe('reminders from tasks', () => {
  const list = remindersOf(
    notesOf({
      'Work/Plan.md': '# Plan\n\n- [ ] Pay the invoice 📅 2026-10-24\n- [ ] Book the dentist 📅 2026-10-27\n- [ ] Renew the passport 📅 2026-11-30\n- [ ] Someday maybe\n- [x] Done thing 📅 2026-10-20\n',
    }),
    DAY,
  )

  it('takes open tasks with a date that is late or within two weeks, most urgent first', () => {
    expect(list.map((r) => r.text)).toEqual(['Pay the invoice', 'Book the dentist'])
    expect(list[0]!.urgency).toBeGreaterThan(list[1]!.urgency)
    expect(list[0]!.due).toBe('2026-10-24')
    expect(list.every((r) => r.source === 'task')).toBe(true)
  })

  it('leaves out done tasks, undated ones and ones due much later', () => {
    const texts = list.map((r) => r.text).join('|')
    expect(texts).not.toContain('Done thing')
    expect(texts).not.toContain('Someday')
    expect(texts).not.toContain('passport')
  })

  it('names each by its note and line, which stays the same when other things change', () => {
    expect(list[0]!.key).toBe('Work/Plan#2')
    expect(list[0]!.note).toBe('Work/Plan')
  })
})

describe('reminders from tags', () => {
  const list = remindersOf(
    notesOf({
      'Ideas/Call back.md': '---\ntags: [reminder]\n---\n# Call back\n',
      'Ideas/Inline.md': '# Inline\n\nDo not forget this #reminder\n',
      'Ideas/Plain.md': '# Plain\n',
      'Archive/Old.md': '---\ntags: [reminder]\n---\n# Old\n',
    }),
    DAY,
  )

  it('turns a note tagged reminder into one, in the front matter or in the text', () => {
    expect(list.map((r) => r.note).sort()).toEqual(['Ideas/Call back', 'Ideas/Inline'])
    for (const r of list) {
      expect(r.source).toBe('tag')
      expect(r.due).toBeNull()
      expect(r.urgency).toBe(REMINDER_TAGGED_URGENCY)
    }
  })
})

describe('how many there are', () => {
  it('never more than the cap, the most urgent kept, and the same every time', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`N/n${String(i).padStart(2, '0')}.md`] = `# n\n\n- [ ] task ${i} 📅 2026-10-${String(1 + (i % 25)).padStart(2, '0')}\n`
    const notes = notesOf(files)
    const a = remindersOf(notes, DAY)
    expect(a.length).toBe(REMINDER_MAX)
    expect(remindersOf(notes, DAY).map((r) => r.key)).toEqual(a.map((r) => r.key))
    for (let i = 1; i < a.length; i++) expect(a[i - 1]!.urgency).toBeGreaterThanOrEqual(a[i]!.urgency)
    expect(remindersOf(notes, DAY, 3).length).toBe(3)
    expect(remindersOf(notes, DAY, 0)).toEqual([])
  })

  it('shortens a long task to a label that fits', () => {
    const long = 'x'.repeat(300)
    const r = remindersOf(notesOf({ 'A/a.md': `# a\n\n- [ ] ${long} 📅 2026-10-25\n` }), DAY)[0]!
    expect(r.text.length).toBeLessThanOrEqual(REMINDER_TEXT_MAX)
    expect(r.text.endsWith('…')).toBe(true)
  })
})
