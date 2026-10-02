import { describe, expect, it } from 'vitest'
import { parseNote } from '@aether/core'
import { forgeDirOf, forgeStar, isForgeName, projectStars, type ForgeStarCandidate } from '../src/renderer/forge-star.js'

const root = (path: string, mount = '') => ({ path, mount, label: path })
const star = (path: string, ...names: string[]): ForgeStarCandidate => ({
  id: `folder:${path}`,
  path,
  names: [path.slice(path.lastIndexOf('/') + 1), ...names],
})

describe('the Concept Forge star', () => {
  it('knows the name however it is spelled', () => {
    for (const n of ['Concept Forge', 'ConceptForge', 'concept-forge', 'CONCEPT_FORGE', ' concept forge ']) expect(isForgeName(n)).toBe(true)
    for (const n of ['Concept', 'Forge', 'Concept Forge 2', 'PORTALz', '']) expect(isForgeName(n)).toBe(false)
  })

  it('finds the vault folder of the page, with the mount in a vault of several roots', () => {
    expect(forgeDirOf('/home/me/vault/Projects/ConceptForge/concept-forge.html', [root('/home/me/vault')], 'linux')).toBe('Projects/ConceptForge')
    expect(forgeDirOf('/home/me/vault/concept-forge.html', [root('/home/me/vault/')], 'linux')).toBe('')
    expect(forgeDirOf('/home/me/other/concept-forge.html', [root('/home/me/vault')], 'linux')).toBeNull()
    // `vault2` is not inside `vault`.
    expect(forgeDirOf('/home/me/vault2/concept-forge.html', [root('/home/me/vault')], 'linux')).toBeNull()
    const drives = [root('D:\\', 'D'), root('F:\\', 'F')]
    expect(forgeDirOf('F:\\Lunco\\ConceptForge\\concept-forge.html', drives, 'win32')).toBe('F/Lunco/ConceptForge')
    expect(forgeDirOf('f:\\lunco\\concept-forge.html', drives, 'win32')).toBe('F/lunco')
    expect(forgeDirOf('F:\\concept-forge.html', drives, 'win32')).toBe('F')
    // Case counts on Linux.
    expect(forgeDirOf('/Home/me/vault/x.html', [root('/home/me/vault')], 'linux')).toBeNull()
    // The deepest root holding it wins.
    expect(forgeDirOf('F:\\Art\\Forge\\x.html', [root('F:\\', 'F'), root('F:\\Art', 'Art')], 'win32')).toBe('Art/Forge')
    expect(forgeDirOf(null, drives, 'win32')).toBeNull()
  })

  it('puts the screen on the project called Concept Forge, else on the project holding the page', () => {
    const portalz = star('F/Lunco/PORTALz')
    const forge = star('F/Lunco/ConceptForge', 'ConceptForge', 'Concept Forge')
    // By name, wherever the page is.
    expect(forgeStar([portalz, forge], null, 'win32')).toBe(forge.id)
    expect(forgeStar([portalz, forge], 'D/Downloads', 'win32')).toBe(forge.id)
    // Without one: the deepest project star whose folder holds the page.
    const lunco = star('F/Lunco')
    expect(forgeStar([lunco, portalz], 'F/Lunco/PORTALz/Tools', 'win32')).toBe(portalz.id)
    expect(forgeStar([lunco, portalz], 'f/lunco/tools', 'win32')).toBe(lunco.id)
    expect(forgeStar([lunco, portalz], 'D/Downloads', 'win32')).toBeNull()
    expect(forgeStar([portalz], null, 'win32')).toBeNull()
    expect(forgeStar([], 'F/Lunco', 'win32')).toBeNull()
  })

  it('among several called Concept Forge: the one holding the page, else the one whose folder says it, else the shallowest', () => {
    const a = star('F/Old/Concept Forge')
    const b = star('F/Lunco/Trainer', 'Concept Forge')
    const c = star('F/ConceptForge')
    expect(forgeStar([a, b, c], 'F/Lunco/Trainer/build', 'win32')).toBe(b.id)
    expect(forgeStar([a, b, c], null, 'win32')).toBe(c.id)
    expect(forgeStar([b], null, 'win32')).toBe(b.id)
  })

  it('reads the project stars from the notes: each project note’s home folder with its names', () => {
    const notes = [
      parseNote({ path: 'Projects/ConceptForge.md', content: '---\nstatus: active\naliases: [Concept Forge]\n---\n# ConceptForge\n', mtime: 1 }),
      parseNote({ path: 'Projects/PORTALz.md', content: '---\nstatus: active\n---\n# PORTALz\n', mtime: 1 }),
      // A project without a folder is no star.
      parseNote({ path: 'Projects/Someday.md', content: '---\nstatus: active\n---\n# Someday\n', mtime: 1 }),
      parseNote({ path: 'Areas/Health.md', content: '# Health\n', mtime: 1 }),
    ]
    const stars = projectStars(notes, new Set(['', 'Projects', 'Projects/ConceptForge', 'Projects/PORTALz', 'Areas']))
    expect(stars).toEqual([
      { id: 'folder:Projects/ConceptForge', path: 'Projects/ConceptForge', names: ['ConceptForge', 'ConceptForge', 'Concept Forge'] },
      { id: 'folder:Projects/PORTALz', path: 'Projects/PORTALz', names: ['PORTALz', 'PORTALz'] },
    ])
    expect(forgeStar(stars, null, 'linux')).toBe('folder:Projects/ConceptForge')
  })
})
