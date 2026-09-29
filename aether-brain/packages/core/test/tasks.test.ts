import { describe, expect, it } from 'vitest'
import { addTask, deleteTask, editTask, extractTasks, moveTask, parseNote, projectNote, setTaskDone, taskProgress } from '../src'

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

  it('adds tasks at the end of the section, creating it when missing', () => {
    const added = addTask(NOTE, 'Model the monolith')
    const lines = added.split('\n')
    const idx = lines.indexOf('- [ ] Model the monolith')
    expect(idx).toBeGreaterThan(0)
    expect(lines[idx - 1]).toBe('  - [ ] nested sub-task')
    expect(lines[idx + 1]).toBe('')
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
