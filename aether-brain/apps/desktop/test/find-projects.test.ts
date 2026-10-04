import { describe, expect, it } from 'vitest'
import { HINT_MIN_FOLDERS, reviewRows, tickedPaths, wantsHint } from '../src/renderer/find-projects'
import type { ProjectCandidateDto } from '../src/shared/ipc'

const sure = (path: string, kind = 'git repository'): ProjectCandidateDto => ({ path, name: path.slice(path.lastIndexOf('/') + 1), kind, strong: true, files: 0 })
const art = (path: string, files = 3): ProjectCandidateDto => ({ path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'Blender files', strong: false, files })

describe('reviewRows: what Find projects offers and ticks', () => {
  it('ticks outermost finds, sure projects anywhere outside another sure one, and never a project’s art folder', () => {
    const rows = reviewRows(
      [
        art('D/Art'),
        sure('D/Work/Portals', 'Unreal project'),
        sure('D/Art/Game'),
        art('D/Art/Sketches'),
        art('D/Work/Portals/SourceArt'),
        sure('D/Work/Portals/Plugins/Tool'),
      ],
      [],
    )
    const by = new Map(rows.map((r) => [r.path, r]))
    expect(by.get('D/Art')).toMatchObject({ ticked: true, inside: null })
    expect(by.get('D/Work/Portals')).toMatchObject({ ticked: true, inside: null })
    // A sure project inside an art folder is its own project.
    expect(by.get('D/Art/Game')).toMatchObject({ ticked: true, inside: 'Art' })
    // Art inside art, art inside a project, a project inside a project: offered, not ticked.
    expect(by.get('D/Art/Sketches')).toMatchObject({ ticked: false, inside: 'Art' })
    expect(by.get('D/Work/Portals/SourceArt')).toMatchObject({ ticked: false, inside: 'Portals' })
    expect(by.get('D/Work/Portals/Plugins/Tool')).toMatchObject({ ticked: false, inside: 'Portals' })
    expect(rows.map((r) => r.path)).toEqual(['D/Art', 'D/Work/Portals', 'D/Art/Game', 'D/Art/Sketches', 'D/Work/Portals/SourceArt', 'D/Work/Portals/Plugins/Tool'])
  })

  it('leaves out stars the vault has and archived folders; inside a star counts as inside a sure project', () => {
    const rows = reviewRows(
      [sure('F/MASTERIMAGES'), art('f/masterimages/Concept'), sure('F/MASTERIMAGES/tools/x'), art('Archive/Old'), art('D/Projects/Archive/x'), art('F/Paint')],
      [{ path: 'F/MASTERIMAGES', name: 'Master images' }],
    )
    expect(rows.map((r) => [r.path, r.ticked, r.inside])).toEqual([
      ['f/masterimages/Concept', false, 'Master images'],
      ['F/MASTERIMAGES/tools/x', false, 'Master images'],
      ['D/Projects/Archive/x', true, null],
      ['F/Paint', true, null],
    ])
  })

  it('lists the ticked paths in row order', () => {
    const rows = reviewRows([art('A'), art('B'), art('C')], [])
    expect(tickedPaths(rows, new Set(['C', 'A', 'Z']))).toEqual(['A', 'C'])
  })
})

describe('the Find projects hint', () => {
  it('shows for a brain with at most one star and enough folders', () => {
    expect(wantsHint(0, HINT_MIN_FOLDERS)).toBe(true)
    expect(wantsHint(1, 400)).toBe(true)
    expect(wantsHint(2, 400)).toBe(false)
    expect(wantsHint(0, HINT_MIN_FOLDERS - 1)).toBe(false)
  })
})
