import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, isProjectNote, type VaultFile } from '@aether/core'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

/** A fresh store and the Projects board rendered as server markup; `resolvers()` counts the link indexes built since `reset()`. */
async function renderer() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  let built = 0
  vi.doMock('@aether/core', async (orig) => {
    const core = await orig<typeof import('@aether/core')>()
    return {
      ...core,
      LinkResolver: class extends core.LinkResolver {
        constructor(notes: ConstructorParameters<typeof core.LinkResolver>[0]) {
          super(notes)
          built++
        }
      },
    }
  })
  const { useAether } = await import('../src/store')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const s = () => useAether.getState()
  const board = async () => {
    const mod = (await import('../src/components/ProjectsView.tsx')) as { ProjectsView: () => React.ReactNode }
    Object.assign(useAether.getInitialState(), useAether.getState())
    return renderToStaticMarkup(createElement(mod.ProjectsView))
  }
  return { useAether, s, board, resolvers: () => built, reset: () => void (built = 0) }
}

afterEach(() => {
  vi.doUnmock('@aether/core')
  vi.unstubAllGlobals()
})

/** Folder names a real drive has: spaces, brackets, hashes, percent, unicode, long names, dots. */
const ODD = [
  'My Game (copy)',
  'Level [draft]',
  'Art #2',
  '100% done',
  'Tom & Jerry',
  'Café ☕ Noir',
  '作品 2024',
  'a'.repeat(180),
  'dots.v1.2.final',
  "Don't Panic",
  'Say "hi"',
  'Ünïcödé',
  'x|y',
  '[[wiki]] odd',
  'tilde~1',
  'brace {x}',
  'Colon: Title',
  '- dash start',
  '> quote start',
  '# hash start',
  '%20 encoded',
]

describe('the Projects board', () => {
  it('lists a vault full of stars made by Find projects, odd names and all', async () => {
    const { s, board } = await renderer()
    const dirs = ODD.map((n, i) => `${i % 2 ? 'D' : 'F'}/Stuff/${n}`)
    await s().openVault(new MemoryVaultAdapter([{ path: 'D/Welcome.md', content: '# Welcome\n' }], { folders: dirs }))
    const res = await s().makeProjects(dirs)
    expect(res.failed).toBe(0)
    expect([...s().notes.values()].filter(isProjectNote).length).toBe(ODD.length)
    s().setView('projects')
    const out = await board()
    expect(out).toContain(`${ODD.length} boards`)
  })

  it('builds one link index for all the tasks of a project, never one per task', async () => {
    // Each task row used to build its own index of every note (and kept it): a long to-do list in a big vault
    // froze the window for seconds and ate gigabytes, which looked like a blank screen.
    const { s, board, resolvers, reset } = await renderer()
    const files: VaultFile[] = []
    for (let i = 0; i < 300; i++) files.push({ path: `D/Stuff/n${i % 20}/Note ${i}.md`, content: `# Note ${i}\n` })
    const tasks = Array.from({ length: 80 }, (_, i) => `- [ ] task ${i} see [[Note ${i}]] and [[Nowhere ${i}]] #t${i % 5}`).join('\n')
    files.push({ path: 'D/Projects/Big.md', content: `---\ntype: project\nstatus: active\n---\n# Big\n\n## To do\n\n${tasks}\n` })
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    reset()
    const out = await board()
    expect(out).toContain('To do · 80')
    expect(out).toContain('task 79')
    // The links in the tasks are still resolved: a note that exists is a link to it, one that does not is a ghost.
    expect(out).toMatch(/title="D\/Stuff\/n9\/Note 9"/)
    expect(out).toMatch(/wikilink wikilink-ghost" title="Create &quot;Nowhere 3&quot;"/)
    expect(resolvers()).toBeLessThanOrEqual(1)
  })

  it('builds no link index at all when no task has a link', async () => {
    const { s, board, resolvers, reset } = await renderer()
    const files: VaultFile[] = [{ path: 'D/Projects/Plain.md', content: '---\ntype: project\n---\n# Plain\n\n## To do\n\n- [ ] one\n- [ ] two #tag\n' }]
    for (let i = 0; i < 50; i++) files.push({ path: `D/Stuff/Note ${i}.md`, content: `# Note ${i}\n` })
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    reset()
    expect(await board()).toContain('To do · 2')
    expect(resolvers()).toBe(0)
  })
})
