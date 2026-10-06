import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, type VaultFile } from '@aether/core'

/**
 * Holes the first v0.8.4 tests left open, found by mutation testing (each case names the mutation it kills):
 * the link/tag pattern's own bounds, every cap on a drawn text one by one (the old catch-all `out.length < 80000`
 * let a cap of 5,000 characters through), the board's store subscriptions per task row, the one-pass folder
 * counts, and how much of a note is read for its summary. Server-rendered, like projects-board.test.ts.
 */

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

/** A Map / Set that counts how many times it is walked (`has` / `get` are not walks). */
class WalkedMap<K, V> extends Map<K, V> {
  walks = 0
  override values() {
    this.walks++
    return super.values()
  }
  override keys() {
    this.walks++
    return super.keys()
  }
  override entries() {
    this.walks++
    return super.entries()
  }
  override forEach(...a: Parameters<Map<K, V>['forEach']>) {
    this.walks++
    return super.forEach(...a)
  }
  override [Symbol.iterator]() {
    this.walks++
    return super[Symbol.iterator]()
  }
}
class WalkedSet<T> extends Set<T> {
  walks = 0
  override values() {
    this.walks++
    return super.values()
  }
  override keys() {
    this.walks++
    return super.keys()
  }
  override entries() {
    this.walks++
    return super.entries()
  }
  override forEach(...a: Parameters<Set<T>['forEach']>) {
    this.walks++
    return super.forEach(...a)
  }
  override [Symbol.iterator]() {
    this.walks++
    return super[Symbol.iterator]()
  }
}

/** A fresh store and the Projects board as server markup; `hooks()` counts the store hooks the board called. */
async function renderer() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  let hooks = 0
  vi.doMock('../src/store', async (orig) => {
    const real = await orig<typeof import('../src/store')>()
    const counted = Object.assign((...a: unknown[]) => (hooks++, (real.useAether as unknown as (...x: unknown[]) => unknown)(...a)), real.useAether)
    return { ...real, useAether: counted as unknown as typeof real.useAether }
  })
  const { useAether } = await import('../src/store')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const s = () => useAether.getState()
  const board = async () => {
    const mod = (await import('../src/components/ProjectsView')) as { ProjectsView: () => React.ReactNode }
    Object.assign(useAether.getInitialState(), useAether.getState())
    hooks = 0
    return renderToStaticMarkup(createElement(mod.ProjectsView))
  }
  return { useAether, s, board, hooks: () => hooks }
}

afterEach(() => {
  vi.doUnmock('../src/store')
  vi.unstubAllGlobals()
})

/** The longest run of one character in `s`. */
function longestRun(s: string, ch: string): number {
  let best = 0
  let run = 0
  for (const c of s) {
    run = c === ch ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

const project = (path: string, fm: string, body: string): VaultFile => ({ path, content: `---\ntype: project\n${fm}---\n${body}` })

describe('the link and tag pattern of a task', () => {
  it('draws a link target of at most 200 characters without brackets, and a tag of at most 100 characters', async () => {
    // Kills: INLINE_RE back to the unbounded pattern. The pattern is only ever run on the text already cut to 2,000
    // characters (so even the old pattern costs ~2 ms a row there, ~0.4 s for a page of 200 hostile rows: too little
    // for a timing assertion that never flakes); what it must keep is its bounds, which are observable.
    const { s, board } = await renderer()
    const tasks = [
      '- [ ] fine [[Real Note]] and #ok',
      `- [ ] long [[${'a'.repeat(300)}]] end`,
      '- [ ] bracket [[a[b]] end',
      `- [ ] longtag #${'b'.repeat(150)} end`,
    ].join('\n')
    await s().openVault(new MemoryVaultAdapter([{ path: 'D/Real Note.md', content: '# Real Note\n' }, project('D/Projects/P.md', '', `# P\n\n## To do\n\n${tasks}\n`)]))
    s().setView('projects')
    const out = await board()
    // The ordinary link is a link to the note, the ordinary tag a tag.
    expect(out).toMatch(/title="D\/Real Note"/)
    expect(out).toContain('>#ok</a>')
    // A 300-character target is plain text (no anchor made from it), and so is a target holding a bracket.
    expect(out).toContain(`[[${'a'.repeat(300)}]]`)
    expect(out).toContain('bracket [[a[b]] end')
    expect(out).not.toMatch(/wikilink-ghost" title="Create &quot;a{50}/)
    // A tag is cut: the anchor holds at most the # and 101 more characters, the rest is plain text after it.
    const tag = /class="tag">(#b+)</.exec(out)
    expect(tag).not.toBeNull()
    expect(tag![1]!.length).toBeLessThanOrEqual(110)
    expect(longestRun(out, 'b')).toBe(150)
  })
})

describe('every text the board draws has its own cap', () => {
  it('cuts the heading label, its tooltip, the title, the path, the tags, the summary and the card texts', async () => {
    // Kills (one by one): MAX_SECTION_CHARS, the section tooltip's MAX_PATH_CHARS, MAX_TITLE_CHARS, MAX_PATH_CHARS,
    // MAX_TAG_CHARS, MAX_SUMMARY_CHARS and the card's title, status, tag and next-task cuts.
    const { s, board } = await renderer()
    // A path of 400 characters, over what the board draws of one (three folders, so no run of one letter is longer than the cap).
    const LONG_PATH = `D/Projects/${'P'.repeat(120)}/${'P'.repeat(120)}/${'P'.repeat(120)}/Sel`
    const files: VaultFile[] = [
      // The selected project: every text of the header and of a task row is long, each with a letter of its own.
      {
        path: `${LONG_PATH}.md`,
        content: `---\ntitle: ${'T'.repeat(5000)}\ntype: project\nstatus: active\ntags: [${'g'.repeat(5000)}]\n---\n# Sel\n\n> ${'Y'.repeat(100_000)}\n\n## ${'H'.repeat(20_000)}\n\n- [ ] ${'K'.repeat(100_000)}\n`,
      },
      // A project that is only a card: its title, status, tag and next task are long.
      {
        path: 'D/Projects/Card.md',
        content: `---\ntitle: ${'Z'.repeat(5000)}\ntype: project\nstatus: ${'W'.repeat(5000)}\ntags: [${'q'.repeat(5000)}]\nupdated: 2020-01-01\n---\n# Card\n\n- [ ] ${'N'.repeat(5000)}\n`,
      },
    ]
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    s().selectProject(LONG_PATH)
    const out = await board()
    expect(out).toContain('2 boards')
    // The selected project.
    expect(longestRun(out, 'T')).toBeLessThanOrEqual(200)
    const path = /<div class="mt-0\.5 font-mono text-\[10\.5px\] text-faint">([^<]*)<\/div>/.exec(out)
    expect(path).not.toBeNull()
    expect(path![1]!.length).toBeLessThanOrEqual(300)
    expect(longestRun(out, 'Y')).toBeLessThanOrEqual(600)
    expect(longestRun(out, 'K')).toBeLessThanOrEqual(2000)
    expect(longestRun(out, 'g')).toBeLessThanOrEqual(40)
    // The heading above the task: the label drawn, and the tooltip it carries.
    const section = /<span class="shrink-0 text-\[10px\] text-faint" title="([^"]*)">([^<]*)<\/span>/.exec(out)
    expect(section).not.toBeNull()
    expect(section![2]!.length).toBeLessThanOrEqual(41)
    expect(section![1]!.length).toBeLessThanOrEqual(301)
    expect(longestRun(out, 'H')).toBeLessThanOrEqual(300)
    // The card.
    expect(longestRun(out, 'Z')).toBeLessThanOrEqual(120)
    expect(longestRun(out, 'W')).toBeLessThanOrEqual(24)
    expect(longestRun(out, 'q')).toBeLessThanOrEqual(24)
    expect(longestRun(out, 'N')).toBeLessThanOrEqual(160)
    // Everything above together is a few tens of KB, not megabytes.
    expect(out.length).toBeLessThan(30_000)
  })
})

describe('what the board costs per row and per folder', () => {
  it('calls the same number of store hooks for 10 tasks as for 150: a task row subscribes to nothing', async () => {
    // Kills: TaskText back to `useAether((s) => s.openNote)` and friends (a subscription, a fiber and a closure per row).
    const counts: number[] = []
    for (const n of [10, 150]) {
      const { s, board, hooks } = await renderer()
      const tasks = Array.from({ length: n }, (_, i) => `- [ ] task ${i} see [[Note ${i}]] #t${i % 3}`).join('\n')
      await s().openVault(new MemoryVaultAdapter([project('D/Projects/P.md', '', `# P\n\n## To do\n\n${tasks}\n`), { path: 'D/Note 1.md', content: '# Note 1\n' }]))
      s().setView('projects')
      const out = await board()
      expect((out.match(/data-task=/g) ?? []).length).toBe(n)
      counts.push(hooks())
    }
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBe(counts[0])
  })

  it('walks the notes and the folders a constant number of times, however many cards and folder chips it draws', async () => {
    // Kills: `noteCounts` as a scan of every note per folder chip (and per project's total), `subfolders` as a scan of
    // every folder per card. Counted as walks over the store's Map / Set, so no timing is involved.
    const { useAether, s, board } = await renderer()
    const files: VaultFile[] = [{ path: 'D/Welcome.md', content: '# Welcome\n' }]
    const folders: string[] = []
    // 40 projects with a folder of their own (40 cards), and one project with 300 folders (the first 48 are drawn).
    for (let i = 0; i < 40; i++) files.push({ path: `D/Projects/Card ${i}/Card ${i}.md`, content: `---\ntype: project\nupdated: 2026-01-${String(10 + (i % 18))}\n---\n# Card ${i}\n\n- [ ] x\n` })
    files.push({ path: 'D/Projects/Big/Big.md', content: '---\ntype: project\nstatus: active\n---\n# Big\n\n- [ ] x\n' })
    for (let i = 0; i < 300; i++) {
      folders.push(`D/Projects/Big/sub ${String(i).padStart(3, '0')}`)
      files.push({ path: `D/Projects/Big/sub ${String(i).padStart(3, '0')}/n.md`, content: '# n\n' })
    }
    await s().openVault(new MemoryVaultAdapter(files, { folders }))
    s().setView('projects')
    s().selectProject('D/Projects/Big/Big')
    const notes = new WalkedMap(s().notes)
    const dirs = new WalkedSet(s().folders)
    useAether.setState({ notes, folders: dirs })
    notes.walks = 0
    dirs.walks = 0
    const out = await board()
    expect((out.match(/class="chip"/g) ?? []).length).toBeGreaterThan(40)
    expect((out.match(/data-project-card=/g) ?? []).length).toBeGreaterThan(10)
    // The note count of a chip is right: the folder holds one note.
    expect(out).toContain('title="D/Projects/Big/sub 000 · 1 note — fly there"')
    // A few passes (listing the projects, counting the notes of each folder, grouping the folders), not one per chip or card.
    expect(notes.walks).toBeLessThanOrEqual(4)
    expect(dirs.walks).toBeLessThanOrEqual(4)
  })
})

describe('a summary read only in part is never edited in place', () => {
  it('a quote of 20,000 raw characters or more (its tail not read) is not editable, however the whitespace collapses', async () => {
    const { s, board } = await renderer()
    const files: VaultFile[] = [
      project('D/Projects/Edge.md', '', `# Edge\n\n> ${'a'.repeat(19_999)}\n> TAIL\n`),
      project('D/Projects/Spaced.md', '', `# Spaced\n\n${Array.from({ length: 330 }, (_, i) => `> ${'word  '.repeat(11)}${i}`).join('\n')}\n> TAIL\n`),
      project('D/Projects/Gaps.md', '', `# Gaps\n\n${Array.from({ length: 300 }, () => `> ${'x'.repeat(70)}\n>`).join('\n')}\n> TAIL\n`),
      project('D/Projects/Late.md', '', `${'x'.repeat(250_000)}\n\n# Late\n\n> the real summary\n`),
      project('D/Projects/Short.md', '', '# Short\n\n> one short line\n> and a second one\n'),
    ]
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    for (const id of ['Edge', 'Spaced', 'Gaps', 'Late']) {
      s().selectProject(`D/Projects/${id}`)
      expect(await board(), id).toContain('too long to edit here')
    }
    s().selectProject('D/Projects/Short')
    const short = await board()
    expect(short).toContain('Edit the summary')
    expect(short).not.toContain('too long to edit here')
  })
})

describe('how much of a note is read for its summary', () => {
  it('never reads a heading or a quote that starts past 200,000 characters, and does not edit a summary of 20,000 or more in place', async () => {
    // Kills: SUMMARY_SCAN_CHARS removed in core (projectSummary) or in the board (summaryQuote); SUMMARY_EDIT_MAX removed.
    const { s, board } = await renderer()
    const files: VaultFile[] = [
      // One 250 KB paragraph, and a heading with a quote only after it.
      project('D/Projects/Late.md', '', `${'x'.repeat(250_000)}\n\n# Late\n\n> late summary\n`),
      // A 100 KB quote line: far over what can be edited in place.
      project('D/Projects/Long.md', '', `# Long\n\n> ${'word '.repeat(20_000)}\n`),
      project('D/Projects/Short.md', '', '# Short\n\n> one short line\n'),
    ]
    await s().openVault(new MemoryVaultAdapter(files))
    s().setView('projects')
    const open = async (id: string) => {
      s().selectProject(id)
      return board()
    }
    const late = await open('D/Projects/Late')
    expect(late).not.toContain('late summary')
    expect(late).toContain('too long to edit here')
    const long = await open('D/Projects/Long')
    expect(long).toContain('too long to edit here')
    const short = await open('D/Projects/Short')
    expect(short).toContain('one short line')
    expect(short).toContain('Edit the summary')
    expect(short).not.toContain('too long to edit here')
  })
})
