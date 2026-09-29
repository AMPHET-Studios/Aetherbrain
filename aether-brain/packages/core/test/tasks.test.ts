import { describe, expect, it } from 'vitest'
import { addTask, atxHeading, deleteTask, editTask, extractTasks, moveTask, parseNote, projectNote, setTaskDone, taskProgress } from '../src'

const NOTE = `---
title: PORTALz
type: project
---
# PORTALz

## To do

- [ ] Block out the terrace
- [x] Pick the palette ✅ 2026-09-20
  - [ ] nested sub-task

## Notes

\`\`\`md
- [ ] not a task (code)
\`\`\`

* [X] Star bullet done
`

describe('tasks', () => {
  it('extracts tasks with sections, stamps and nesting, ignoring code', () => {
    const t = extractTasks(NOTE)
    expect(t.map((x) => [x.text, x.done, x.doneAt, x.section, x.indent])).toEqual([
      ['Block out the terrace', false, null, 'To do', 0],
      ['Pick the palette', true, '2026-09-20', 'To do', 0],
      ['nested sub-task', false, null, 'To do', 2],
      ['Star bullet done', true, null, 'Notes', 0],
    ])
    expect(taskProgress(t)).toEqual({ done: 2, total: 4, pct: 50 })
  })

  it('toggles done in place with a date stamp and back', () => {
    const t = extractTasks(NOTE)
    const first = t[0]!
    const done = setTaskDone(NOTE, first.line, true, '2026-09-24')
    expect(done.split('\n')[first.line]).toBe('- [x] Block out the terrace ✅ 2026-09-24')
    const undone = setTaskDone(done, t[1]!.line, false)
    expect(undone.split('\n')[t[1]!.line]).toBe('- [ ] Pick the palette')
    // Everything else untouched.
    expect(undone.split('\n').length).toBe(NOTE.split('\n').length)
    expect(setTaskDone(NOTE, 0, true)).toBe(NOTE)
  })

  it('moves an open task past hidden done tasks with sameState', () => {
    const raw = '## To do\n\n- [ ] A\n- [x] X ✅ 2026-01-01\n- [ ] B\n'
    const b = raw.split('\n').indexOf('- [ ] B')
    // Plain move swaps with the done task right above.
    expect(moveTask(raw, b, -1).raw).toBe('## To do\n\n- [ ] A\n- [ ] B\n- [x] X ✅ 2026-01-01\n')
    // sameState passes over it to the previous open task.
    const up = moveTask(raw, b, -1, { sameState: true })
    expect(up.raw).toBe('## To do\n\n- [ ] B\n- [x] X ✅ 2026-01-01\n- [ ] A\n')
    expect(up.raw.split('\n')[up.line]).toBe('- [ ] B')
    // No open task above: no-op.
    expect(moveTask(up.raw, up.line, -1, { sameState: true })).toEqual({ raw: up.raw, line: up.line })
  })

  it('adds tasks after the last open task of the section, creating it when missing', () => {
    const added = addTask(NOTE, 'Model the monolith')
    const lines = added.split('\n')
    const idx = lines.indexOf('- [ ] Model the monolith')
    expect(idx).toBeGreaterThan(0)
    // Open tasks stay together above the ticked-off ones.
    expect(lines[idx - 1]).toBe('- [ ] Block out the terrace')
    expect(lines[idx + 1]).toBe('- [x] Pick the palette ✅ 2026-09-20')
    const again = addTask(added, 'Rig the drone').split('\n')
    expect(again.indexOf('- [ ] Rig the drone')).toBe(again.indexOf('- [ ] Model the monolith') + 1)
    // Nothing open yet: after the last task, sub-tasks included.
    const allDone = addTask(setTaskDone(NOTE, extractTasks(NOTE)[0]!.line, true, '2026-09-24'), 'Next').split('\n')
    expect(allDone[allDone.indexOf('- [ ] Next') - 1]).toBe('  - [ ] nested sub-task')
    // An open parent keeps its sub-tasks: the new task goes after the whole block.
    const parent = '## To do\n\n- [ ] Parent\n  - [ ] child\n- [x] Old ✅ 2026-01-01\n'
    expect(addTask(parent, 'New')).toBe('## To do\n\n- [ ] Parent\n  - [ ] child\n- [ ] New\n- [x] Old ✅ 2026-01-01\n')
    const noSection = addTask('# Empty\n\nsome text\n', 'First')
    expect(noSection).toBe('# Empty\n\nsome text\n\n## To do\n\n- [ ] First\n')
    const emptySection = addTask('# X\n\n## To do\n\n## Notes\n', 'A')
    expect(extractTasks(emptySection).map((t) => [t.text, t.section])).toEqual([['A', 'To do']])
    expect(addTask(NOTE, '   ')).toBe(NOTE)
  })

  it('builds a project note the parser understands', () => {
    const p = projectNote({ name: 'ConceptForge', summary: 'Train the eye', tags: ['drawing'], tasks: ['Ship v2'] }, new Date('2026-09-24T12:00:00Z'))
    expect(p.path).toBe('Projects/ConceptForge.md')
    const n = parseNote({ path: p.path, content: p.content })
    expect(n.meta.type).toBe('project')
    expect(n.meta.area).toBe('projects')
    expect(extractTasks(n.raw)).toHaveLength(1)
    expect(projectNote({ name: 'In a drive', dir: 'D/Projects' }).path).toBe('D/Projects/In a drive.md')
  })
})

const BOARD = `---
title: Board
---
# Board

## To do

- [ ] A
  - [ ] a1
  - [x] a2 ✅ 2026-09-01
Some paragraph between tasks.
- [ ] B
* [x] C ✅ 2026-09-20

## Later

- [ ] D
\`\`\`
- [ ] code, not a task
\`\`\`
`

const lineOf = (raw: string, text: string) => extractTasks(raw).find((t) => t.text === text)!.line
const texts = (raw: string) => extractTasks(raw).map((t) => `${' '.repeat(t.indent)}${t.text}`)

describe('task editing', () => {
  it('edits text, keeping indent, bullet, checkbox and done stamp', () => {
    const c = lineOf(BOARD, 'C')
    const out = editTask(BOARD, c, 'C, but better')
    expect(out.split('\n')[c]).toBe('* [x] C, but better ✅ 2026-09-20')
    const a2 = lineOf(BOARD, 'a2')
    expect(editTask(BOARD, a2, '- [ ] pasted checkbox ✅ 2020-01-01').split('\n')[a2]).toBe('  - [x] pasted checkbox ✅ 2026-09-01')
    expect(editTask(BOARD, lineOf(BOARD, 'A'), 'multi\nline').split('\n')[lineOf(BOARD, 'A')]).toBe('- [ ] multi line')
    // Everything else untouched.
    expect(out.split('\n').filter((_, i) => i !== c)).toEqual(BOARD.split('\n').filter((_, i) => i !== c))
  })

  it('leaves non-tasks, code and empty text alone', () => {
    expect(editTask(BOARD, lineOf(BOARD, 'B'), '   ')).toBe(BOARD)
    expect(editTask(BOARD, 0, 'x')).toBe(BOARD)
    expect(editTask(BOARD, 99, 'x')).toBe(BOARD)
    const code = BOARD.split('\n').indexOf('- [ ] code, not a task')
    expect(editTask(BOARD, code, 'x')).toBe(BOARD)
    expect(setTaskDone(BOARD, code, true)).toBe(BOARD)
    expect(deleteTask(BOARD, code)).toBe(BOARD)
    expect(moveTask(BOARD, code, -1)).toEqual({ raw: BOARD, line: code })
  })

  it('deletes only the task line', () => {
    const out = deleteTask(BOARD, lineOf(BOARD, 'A'))
    expect(texts(out)).toEqual(['  a1', '  a2', 'B', 'C', 'D'])
    expect(out.split('\n')).toHaveLength(BOARD.split('\n').length - 1)
    expect(deleteTask(BOARD, lineOf(BOARD, 'B')).includes('Some paragraph between tasks.\n* [x] C')).toBe(true)
    expect(deleteTask(BOARD, 1)).toBe(BOARD)
  })

  it('moves a task past non-task lines, carrying its sub-tasks', () => {
    const up = moveTask(BOARD, lineOf(BOARD, 'B'), -1)
    expect(texts(up.raw)).toEqual(['B', 'A', '  a1', '  a2', 'C', 'D'])
    expect(up.line).toBe(lineOf(BOARD, 'A'))
    expect(up.raw.split('\n')[up.line]).toBe('- [ ] B')
    // The paragraph between them stays where it was.
    expect(up.raw).toContain('## To do\n\n- [ ] B\nSome paragraph between tasks.\n- [ ] A\n  - [ ] a1\n')

    const down = moveTask(BOARD, lineOf(BOARD, 'A'), 1)
    expect(texts(down.raw)).toEqual(['B', 'A', '  a1', '  a2', 'C', 'D'])
    expect(down.raw.split('\n')[down.line]).toBe('- [ ] A')
    // Moving it back restores the file exactly.
    const back = moveTask(down.raw, down.line, -1)
    expect(back.raw).toBe(BOARD)
    expect(back.line).toBe(lineOf(BOARD, 'A'))

    const c = moveTask(BOARD, lineOf(BOARD, 'C'), -1)
    expect(texts(c.raw)).toEqual(['A', '  a1', '  a2', 'C', 'B', 'D'])
    expect(c.raw.split('\n')[c.line]).toBe('* [x] C ✅ 2026-09-20')
  })

  it('swaps sub-tasks among siblings only', () => {
    const a2 = moveTask(BOARD, lineOf(BOARD, 'a2'), -1)
    expect(texts(a2.raw)).toEqual(['A', '  a2', '  a1', 'B', 'C', 'D'])
    expect(a2.line).toBe(lineOf(BOARD, 'a1'))
    expect(moveTask(BOARD, lineOf(BOARD, 'a1'), -1).raw).toBe(BOARD)
    expect(moveTask(BOARD, lineOf(BOARD, 'a2'), 1).raw).toBe(BOARD)
  })

  it('is a no-op at the edges of a section', () => {
    const a = lineOf(BOARD, 'A')
    expect(moveTask(BOARD, a, -1)).toEqual({ raw: BOARD, line: a })
    const c = lineOf(BOARD, 'C')
    expect(moveTask(BOARD, c, 1)).toEqual({ raw: BOARD, line: c })
    const d = lineOf(BOARD, 'D')
    expect(moveTask(BOARD, d, -1)).toEqual({ raw: BOARD, line: d })
    expect(moveTask(BOARD, d, 1)).toEqual({ raw: BOARD, line: d })
    expect(moveTask(BOARD, 0, 1)).toEqual({ raw: BOARD, line: 0 })
  })

  it('reads a heading ending in # as its section, and closing hashes as decoration', () => {
    const raw = '# P\n\n## Learn C#\n\n- [ ] one\n\n## Later ##\n\n- [ ] two\n'
    expect(extractTasks(raw).map((t) => t.section)).toEqual(['Learn C#', 'Later'])
    expect(addTask(raw, 'three', 'Learn C#')).toBe('# P\n\n## Learn C#\n\n- [ ] one\n- [ ] three\n\n## Later ##\n\n- [ ] two\n')
  })

  it('works on CRLF files without changing their line endings', () => {
    const crlf = '# P\r\n\r\n## To do\r\n\r\n- [ ] one\r\n- [x] two ✅ 2026-09-02\r\n- [ ] three'
    expect(extractTasks(crlf).map((t) => [t.text, t.done, t.doneAt, t.section])).toEqual([
      ['one', false, null, 'To do'],
      ['two', true, '2026-09-02', 'To do'],
      ['three', false, null, 'To do'],
    ])
    expect(setTaskDone(crlf, 4, true, '2026-09-29')).toBe(crlf.replace('- [ ] one', '- [x] one ✅ 2026-09-29'))
    expect(editTask(crlf, 5, 'TWO')).toBe(crlf.replace('two', 'TWO'))
    expect(deleteTask(crlf, 5)).toBe(crlf.replace('- [x] two ✅ 2026-09-02\r\n', ''))
    // Deleting the last line leaves no stray `\r` behind.
    expect(deleteTask(crlf, 6)).toBe('# P\r\n\r\n## To do\r\n\r\n- [ ] one\r\n- [x] two ✅ 2026-09-02')
    expect(deleteTask(`${crlf}\r\n`, 6)).toBe('# P\r\n\r\n## To do\r\n\r\n- [ ] one\r\n- [x] two ✅ 2026-09-02\r\n')
    const moved = moveTask(crlf, 6, -1)
    expect(moved.raw).toBe('# P\r\n\r\n## To do\r\n\r\n- [ ] one\r\n- [ ] three\r\n- [x] two ✅ 2026-09-02')
    expect(moved.line).toBe(5)
    expect(addTask(crlf, 'four')).toBe(`${crlf}\r\n- [ ] four`)
    expect(addTask(`${crlf}\r\n`, 'four')).toBe(`${crlf}\r\n- [ ] four\r\n`)
    expect(addTask('# P\r\n', 'x')).toBe('# P\r\n\r\n## To do\r\n\r\n- [ ] x\r\n')
  })
})

describe('addTask and fenced code', () => {
  it('never puts the new task inside a fenced block of the section', () => {
    const empty = addTask('# P\n\n## To do\n\n```md\n- [ ] example\n```\n\n## Notes\n', 'Real task')
    expect(empty).toBe('# P\n\n## To do\n\n- [ ] Real task\n\n```md\n- [ ] example\n```\n\n## Notes\n')
    expect(extractTasks(empty).map((t) => [t.text, t.section])).toEqual([['Real task', 'To do']])

    const allDone = addTask('# P\n\n## To do\n\n- [x] shipped\n\nExample:\n\n```md\n- [ ] example\n```\n', 'Real task')
    expect(allDone).toBe('# P\n\n## To do\n\n- [x] shipped\n- [ ] Real task\n\nExample:\n\n```md\n- [ ] example\n```\n')
    expect(extractTasks(allDone).map((t) => t.text)).toEqual(['shipped', 'Real task'])
  })

  it('ignores headings inside fences and frontmatter when finding the section', () => {
    const raw = '---\ntitle: P\n## To do\n---\n# P\n\n```\n## To do\n```\n\n## To do\n\n- [ ] one\n'
    const out = addTask(raw, 'two')
    expect(out).toBe(raw.replace('- [ ] one\n', '- [ ] one\n- [ ] two\n'))
    expect(extractTasks(out).map((t) => [t.text, t.section])).toEqual([
      ['one', 'To do'],
      ['two', 'To do'],
    ])
    // A code block right after the section's heading doesn't end the section either.
    const fenced = addTask('## To do\n\n```\n## Later\n```\n\n- [ ] one\n', 'two')
    expect(extractTasks(fenced).map((t) => [t.text, t.section])).toEqual([
      ['one', 'To do'],
      ['two', 'To do'],
    ])
  })

  it('keeps the new task on one line', () => {
    const out = addTask('## To do\n\n- [ ] one\n', 'two\n```\n## Hijack')
    expect(out).toBe('## To do\n\n- [ ] one\n- [ ] two ``` ## Hijack\n')
  })
})

describe('linear-time parsing (text can come from an AI client)', () => {
  // The regexes the hand-written parsers replaced: quadratic on long whitespace runs.
  const OLD_HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
  const OLD_TASK = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/
  const OLD_STAMP = /\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/
  let seed = 11
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  const randomLine = (alphabet: string[], max: number): string => {
    let line = ''
    for (let i = Math.floor(rnd() * max); i > 0; i--) line += alphabet[Math.floor(rnd() * alphabet.length)] ?? ''
    return line
  }

  it('reads headings exactly like the old regex', () => {
    const alphabet = ['#', '#', '#', ' ', ' ', '\t', 'a', 'C', '#', '\u00a0', '\u2028', '\r', 'x']
    for (let n = 0; n < 30000; n++) {
      const line = randomLine(alphabet, 12)
      const h = OLD_HEADING.exec(line)
      expect(atxHeading(line), JSON.stringify(line)).toEqual(h ? { level: h[1]!.length, text: h[2] } : null)
    }
  })

  it('reads task lines and completion stamps exactly like the old regexes', () => {
    const alphabet = ['-', '*', '+', ' ', ' ', ' ', '\t', '[', ']', ' ', 'x', 'X', 'a', '✅', '2', '0', '-', '1', '\u2028', '\r', '#']
    const stamps = ['', ' ✅ 2026-09-20', '✅2026-01-01 ', ' ✅  1999-12-31\t', '✅ 2026-9-1', ' 2026-01-02', ' x 2026-01-03', '✅ 12026-01-04']
    for (let n = 0; n < 30000; n++) {
      const line = (rnd() < 0.5 ? `${' '.repeat(Math.floor(rnd() * 3))}- [${rnd() < 0.5 ? ' ' : 'x'}] ` : '') + randomLine(alphabet, 10) + (stamps[Math.floor(rnd() * stamps.length)] ?? '')
      const text = line.endsWith('\r') ? line.slice(0, -1) : line
      let want: unknown[] = []
      const m = /^---\s*$/.test(text) || /^\s*(```|~~~)/.test(text) || OLD_HEADING.test(text) ? null : OLD_TASK.exec(text)
      if (m) {
        const stamp = OLD_STAMP.exec(m[4] ?? '')
        const body = stamp ? (m[4] ?? '').slice(0, stamp.index) : (m[4] ?? '')
        want = [{ line: 0, text: body.trim(), done: m[3] !== ' ', doneAt: stamp?.[1] ?? null, section: '', indent: (m[1] ?? '').length }]
      }
      expect(extractTasks(line), JSON.stringify(line)).toEqual(want)
    }
  })

  it('stays fast on a long run of whitespace', () => {
    const ws = ' '.repeat(50_000)
    const start = performance.now()
    expect(atxHeading(`# a${ws}x`)).toEqual({ level: 1, text: `a${ws}x` })
    expect(extractTasks(`# a${ws}x\n- [ ] a${ws}✅${ws}x\n- [ ] ${ws}a\rb\n- [x] b${ws}✅ 2026-01-01${ws}`).map((t) => t.doneAt)).toEqual([
      null,
      '2026-01-01',
    ])
    expect(addTask(`# P\n\n## To do${ws}x\n\ntext${ws}x${ws}`, `t${ws}x`).endsWith(`## To do\n\n- [ ] t${ws}x\n`)).toBe(true)
    expect(editTask('- [ ] a\n', 0, `b${ws}✅${ws}x`)).toBe(`- [ ] b${ws}✅${ws}x\n`)
    expect(setTaskDone(`- [ ] a${ws}✅ 2026-01-01${ws}x`, 0, true, '2026-09-29')).toContain('✅ 2026-09-29')
    // Each of these took seconds with the old regexes (quadratic: ~9 minutes for a 1 MB line).
    expect(performance.now() - start).toBeLessThan(300)
  })
})
