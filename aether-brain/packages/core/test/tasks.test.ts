import { describe, expect, it } from 'vitest'
import { addTask, extractTasks, parseNote, projectNote, setTaskDone, taskProgress } from '../src'

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
  })
})
