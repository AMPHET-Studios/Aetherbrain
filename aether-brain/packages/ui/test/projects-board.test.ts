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
  let listed = 0
  vi.doMock('../src/projects', async (orig) => {
    const real = await orig<typeof import('../src/projects')>()
    return {
      ...real,
      listProjects: (...args: Parameters<typeof real.listProjects>) => {
        listed++
        return real.listProjects(...args)
      },
    }
  })
  const { useAether } = await import('../src/store')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const s = () => useAether.getState()
  const { TASK_PAGE, PLANET_FIRST } = await import('../src/components/ProjectsView.tsx')
  const limits = { task: TASK_PAGE, planets: PLANET_FIRST }
  const board = async () => {
    const mod = (await import('../src/components/ProjectsView.tsx')) as { ProjectsView: () => React.ReactNode }
    Object.assign(useAether.getInitialState(), useAether.getState())
    return renderToStaticMarkup(createElement(mod.ProjectsView))
  }
  return { useAether, s, board, limits, resolvers: () => built, listed: () => listed, reset: () => void ((built = 0), (listed = 0)) }
}

afterEach(() => {
  vi.doUnmock('@aether/core')
  vi.doUnmock('../src/projects')
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

describe('the Projects board', { timeout: 180_000 }, () => {
  it('lists a vault full of stars made by Find projects, odd names and all', async () => {
    const { s, board } = await renderer()
    const dirs = ODD.map((n, i) => `${i % 2 ? 'D' : 'F'}/Stuff/${n}`)
    await s().openVault(new MemoryVaultAdapter([{ path: 'D/Welcome.md', content: '# Welcome\n' }], { folders: dirs }))
    const res = await s().makeProjects(dirs)
    expect(res.failed).toBe(0)
    expect([...s().notes.values()].filter(isProjectNote).length).toBe(ODD.length)
    s().setView('projects')
    const out = await board()
    expect(out).toContain(`${ODD.length} projects`)
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

  it('draws nothing, and does none of its work, while the board is closed', async () => {
    const { s, board, listed, reset } = await renderer()
    const files: VaultFile[] = [{ path: 'D/Projects/A.md', content: '---\ntype: project\n---\n# A\n\n- [ ] one\n' }]
    for (let i = 0; i < 50; i++) files.push({ path: `D/Stuff/Note ${i}.md`, content: `# Note ${i}\n` })
    await s().openVault(new MemoryVaultAdapter(files))
    reset()
    expect(s().view).not.toBe('projects')
    expect(await board()).toBe('')
    expect(listed()).toBe(0)
    s().setView('projects')
    expect(await board()).toContain('1 project')
    expect(listed()).toBe(1)
  })

  it('draws a few cards, not one per project, however many projects there are', async () => {
    // 20,000 cards were ~440,000 elements: gigabytes of page memory and a window that dies.
    const { s, board } = await renderer()
    const files: VaultFile[] = Array.from({ length: 20000 }, (_, i) => ({
      path: `D/Art/Proj ${i}/Proj ${i}.md`,
      content: `---\ntype: project\nstatus: active\nupdated: 2026-10-05\n---\n# Proj ${i}\n\n## To do\n\n- [ ] one\n- [x] two\n`,
    }))
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    const t0 = performance.now()
    const out = await board()
    const cards = (out.match(/data-project-card=/g) ?? []).length
    expect(out).toContain('20000 projects')
    expect(cards).toBeGreaterThan(5)
    expect(cards).toBeLessThanOrEqual(30)
    expect((out.match(/</g) ?? []).length).toBeLessThan(5000)
    expect(performance.now() - t0).toBeLessThan(20_000)
    // The scroll bar still stands for every project: the cards above and below are two spacers.
    expect(out).toMatch(/padding-bottom:\d{6,}px/)
  }, 180_000)

  it('draws a page of a long to-do list and offers the rest, down to the last task', async () => {
    const { s, board, limits } = await renderer()
    const TASK_PAGE = limits.task
    const tasks = Array.from({ length: 5000 }, (_, i) => `- [ ] task ${i}`).join('\n')
    await s().openVault(new MemoryVaultAdapter([{ path: 'D/Projects/Big.md', content: `---\ntype: project\nstatus: active\n---\n# Big\n\n## To do\n\n${tasks}\n` }]))
    s().setView('projects')
    const out = await board()
    expect(out).toContain('To do · 5000')
    expect((out.match(/data-task=/g) ?? []).length).toBe(TASK_PAGE)
    expect(out).toContain('task 0<')
    expect(out).toContain(`task ${TASK_PAGE - 1}<`)
    expect(out).not.toContain(`task ${TASK_PAGE}<`)
    expect(out).toContain(`Show ${TASK_PAGE} more · ${5000 - TASK_PAGE} left`)
  })

  it('draws a first few folder chips and a "more" chip for a project with thousands of folders', async () => {
    const { s, board, limits } = await renderer()
    const PLANET_FIRST = limits.planets
    const folders = Array.from({ length: 3000 }, (_, i) => `D/Projects/Big/sub ${i}`)
    await s().openVault(new MemoryVaultAdapter([{ path: 'D/Projects/Big/Big.md', content: '---\ntype: project\nstatus: active\n---\n# Big\n\n- [ ] x\n' }, { path: 'D/Projects/Big/sub 0/n.md', content: '# n\n' }], { folders }))
    s().setView('projects')
    const out = await board()
    expect((out.match(/class="chip"/g) ?? []).length).toBe(PLANET_FIRST + 1)
    expect(out).toContain(`+${3000 - PLANET_FIRST} more`)
    // The notes under a folder are counted (the project folder holds both notes), without scanning the vault for each project.
    expect(out).toContain('2 notes')
    expect(out).toContain('title="D/Projects/Big/sub 0 · 1 note — fly there"')
    // Alphabetical, like before (base letters, so 'sub 0' comes before 'sub 1').
    expect(out.indexOf('sub 0<')).toBeLessThan(out.indexOf('sub 1<'))
  })

  it('cuts every long text instead of drawing it whole: titles, tasks, headings, summaries, tags', async () => {
    const { s, board } = await renderer()
    // Far above every limit (a task is cut at 2,000 characters, a summary at 20,000) yet cheap to parse.
    const huge = 'word '.repeat(60_000)
    const tags = Array.from({ length: 5000 }, (_, i) => `t${i}`).join(', ')
    const files: VaultFile[] = [
      {
        path: 'D/Projects/Long.md',
        content: `---\ntitle: ${'T'.repeat(5000)}\ntype: project\nstatus: active\ntags: [${tags}]\n---\n# Long\n\n> ${huge}\n\n## ${'H'.repeat(20_000)}\n\n- [ ] ${huge}\n- [ ] ${'['.repeat(30_000)}\n- [ ] #tag and [[a]] link\n`,
      },
      // A second project whose next task is huge: its card is drawn too.
      { path: 'D/Projects/Other.md', content: `---\ntype: project\nstatus: paused\n---\n# Other\n\n- [ ] ${huge}\n` },
      // A note with no heading and one 3 MB paragraph.
      { path: 'D/Projects/Wall.md', content: `---\ntype: project\n---\n${huge}\n` },
    ]
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    s().selectProject('D/Projects/Long')
    const t0 = performance.now()
    const out = await board()
    // Project notes of hundreds of KB each, and the board is a few tens of KB.
    expect(out.length).toBeLessThan(80_000)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect((out.match(/class="chip !cursor-default"/g) ?? []).length).toBe(40)
    expect(out).toContain('+4960 more')
    expect(out).toContain('…')
    // The short task still has its tag and its (ghost) link.
    expect(out).toContain('class="tag"')
    expect(out).toContain('wikilink')
  }, 120_000)
  it('draws at most a few links and tags of one task as links, the rest of its text stays plain', async () => {
    const { s, board } = await renderer()
    // 600 tags in 1,800 characters (under the 2,000-character cap of a task): 600 anchors before the cap.
    const tags = Array.from({ length: 600 }, () => '#a').join(' ')
    const links = Array.from({ length: 300 }, (_, i) => `[[N${i}]]`).join(' ')
    await s().openVault(new MemoryVaultAdapter([{ path: 'D/Projects/Dense.md', content: `---\ntype: project\nstatus: active\n---\n# Dense\n\n## To do\n\n- [ ] ${tags}\n- [ ] ${links}\n- [ ] one #tag and [[a]] link\n` }]))
    s().setView('projects')
    const out = await board()
    const anchors = (out.match(/<a /g) ?? []).length
    // Two dense tasks at 40 each, and the short one's two.
    expect(anchors).toBe(40 + 40 + 2)
    expect(out).toContain('class="tag"')
    expect(out).toContain('wikilink')
    expect(out.length).toBeLessThan(60_000)
  })
})
