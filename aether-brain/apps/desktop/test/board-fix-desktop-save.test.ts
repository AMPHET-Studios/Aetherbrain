import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isBoardNote, newBoardNote } from '@aether/core'
import { FsVault } from '../src/main/fsvault.js'
import { MAX_BOARD_TEXT, boardNoteVerdict, checkBoard, isBoardHead, judgeBoardHead, readBoard, saveBoard, type BoardVault } from '../src/main/board-save.js'
import { PictureLedger, boardHandlers } from '../src/main/board-window.js'
import { FakeWin, rig } from './board-fix-desktop-fakes.js'

/**
 * desktop-1 (one IPC), desktop-m6 (no gap, no symlink), integration-2 + desktop-m3 + shell-7 (a note too long for the window is
 * refused before a window exists, with its own sentence), live-window-m3 (an honest message for a head it cannot judge), desktop-m1.
 */

const NOW = new Date('2026-10-09T12:00:00Z')
const board = (title = 'Gate'): string => newBoardNote(title, NOW)
let tmp: string
let root: string
const at = (rel: string): string => path.join(root, ...rel.split('/'))
const put = async (rel: string, content: string | Uint8Array): Promise<void> => {
  await fs.mkdir(path.dirname(at(rel)), { recursive: true })
  await fs.writeFile(at(rel), content)
}
const disk = (rel: string): Promise<string> => fs.readFile(at(rel), 'utf8')

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-fix-save-'))
  root = path.join(tmp, 'vault')
  await put('Boards/Gate.md', board('Gate'))
  await put('Notes/Plain.md', '---\ntitle: Plain\n---\nJust a note.\n')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

const vault = (): FsVault => new FsVault([root])
const edit = (raw: string, line: string): string => raw.replace('## Board', `## Board\n${line}`)

describe('board:save is ONE call: main compares the note with the text the save was made from, then writes', () => {
  it('writes when the note on disk is the text the save was made from', async () => {
    const base = board()
    const next = edit(base, '- note x=0 y=0 w=200 size=18 color=ffffff fill= r=0 » typed')
    expect(await saveBoard({ path: 'Boards/Gate.md', text: next, expectedBase: base }, vault())).toEqual({ ok: true })
    expect(await disk('Boards/Gate.md')).toBe(next)
  })

  it('refuses, writing nothing, when the note is neither that text nor already the new one: somebody else edited it', async () => {
    const base = board()
    const theirs = edit(base, '- note x=9 y=9 w=100 size=18 color=ffffff fill= r=0 » an AI added this')
    await put('Boards/Gate.md', theirs)
    const res = await saveBoard({ path: 'Boards/Gate.md', text: edit(base, '- note x=0 y=0 w=200 size=18 color=ffffff fill= r=0 » mine'), expectedBase: base }, vault())
    expect(res).toMatchObject({ ok: false, changed: true })
    expect(res.ok ? '' : res.reason).toMatch(/changed outside this window/)
    expect(await disk('Boards/Gate.md')).toBe(theirs)
    expect((await fs.readdir(at('Boards'))).sort()).toEqual(['Gate.md'])
  })

  it('takes a repeat of a save whose answer was lost as done (the note already is the new text), without writing again', async () => {
    const base = board()
    const next = edit(base, '- note x=0 y=0 w=200 size=18 color=ffffff fill= r=0 » typed')
    const v = vault()
    const write = vi.spyOn(v, 'write')
    expect(await saveBoard({ path: 'Boards/Gate.md', text: next, expectedBase: base }, v)).toEqual({ ok: true })
    expect(await saveBoard({ path: 'Boards/Gate.md', text: next, expectedBase: base }, v)).toEqual({ ok: true })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('applies the save exactly once even if nobody ever reads its answer (the page went away as it sent it)', async () => {
    const base = board()
    const next = edit(base, '- note x=0 y=0 w=200 size=18 color=ffffff fill= r=0 » typed as the window closed')
    const v = vault()
    const write = vi.spyOn(v, 'write')
    // Sent and forgotten, as a page that is destroyed straight after its message does.
    void saveBoard({ path: 'Boards/Gate.md', text: next, expectedBase: base }, v)
    for (let i = 0; i < 200 && (await disk('Boards/Gate.md')) === base; i++) await new Promise((r) => setTimeout(r, 5))
    expect(await disk('Boards/Gate.md')).toBe(next)
    expect(write).toHaveBeenCalledTimes(1)
    expect((await fs.readdir(at('Boards'))).sort()).toEqual(['Gate.md'])
  })

  it('without a base the note is overwritten, as board:save always did', async () => {
    const theirs = edit(board(), '- note x=9 y=9 w=100 size=18 color=ffffff fill= r=0 » theirs')
    await put('Boards/Gate.md', theirs)
    const next = edit(board(), '- note x=0 y=0 w=200 size=18 color=ffffff fill= r=0 » mine')
    expect(await saveBoard({ path: 'Boards/Gate.md', text: next }, vault())).toEqual({ ok: true })
    expect(await disk('Boards/Gate.md')).toBe(next)
  })

  it('says the note is gone when it vanished, and refuses a base that is not text', async () => {
    const v = vault()
    expect((await saveBoard({ path: 'Boards/Gone.md', text: board(), expectedBase: board() }, v)).ok).toBe(false)
    const res = await saveBoard({ path: 'Boards/Gate.md', text: board(), expectedBase: 5 }, v)
    expect(res).toEqual({ ok: false, reason: 'The text the save was made from must be text' })
    expect(await disk('Boards/Gate.md')).toBe(board())
  })

  it('runs the saves of one note one after the other: a second compares with the note the first wrote, not the one before it', async () => {
    const base = board()
    const a = edit(base, '- note x=1 y=1 w=100 size=18 color=ffffff fill= r=0 » A')
    const b = edit(base, '- note x=2 y=2 w=100 size=18 color=ffffff fill= r=0 » B')
    const real = vault()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const log: string[] = []
    const slow: BoardVault = {
      abs: (p) => real.abs(p),
      stat: (p) => real.stat(p),
      read: async (p) => {
        const t = await real.read(p)
        log.push(`read:${t === a ? 'A' : t === b ? 'B' : 'base'}`)
        return t
      },
      write: async (p, c) => {
        log.push(`write:${c === a ? 'A' : 'B'}:start`)
        await gate
        await real.write(p, c)
        log.push(`write:${c === a ? 'A' : 'B'}:end`)
      },
    }
    const first = saveBoard({ path: 'Boards/Gate.md', text: a, expectedBase: base }, slow)
    const second = saveBoard({ path: 'Boards/Gate.md', text: b, expectedBase: base }, slow)
    await new Promise((r) => setTimeout(r, 60))
    // The second has not looked at the note while the first is still writing it.
    expect(log).toEqual(['read:base', 'write:A:start'])
    release()
    expect(await first).toEqual({ ok: true })
    expect(await second).toMatchObject({ ok: false, changed: true })
    expect(await disk('Boards/Gate.md')).toBe(a)
    expect(log).toEqual(['read:base', 'write:A:start', 'write:A:end', 'read:A'])
  })
})

describe('the saves of one note keep the order they were asked in', () => {
  it('even when judging the first one takes longer than judging the second (a busy machine, a slow disk)', async () => {
    const base = board()
    const a = edit(base, '- note x=1 y=1 w=100 size=18 color=ffffff fill= r=0 » A')
    const b = edit(base, '- note x=2 y=2 w=100 size=18 color=ffffff fill= r=0 » B')
    const real = vault()
    const log: string[] = []
    let stats = 0
    const slowToJudge: BoardVault = {
      abs: (p) => real.abs(p),
      // The first save's look at the note is slow, the second's is immediate: unlined, the second would reach the note first.
      stat: async (p) => {
        const n = stats++
        if (n === 0) await new Promise((r) => setTimeout(r, 80))
        return real.stat(p)
      },
      read: (p) => real.read(p),
      write: async (p, c) => {
        log.push(`write:${c === a ? 'A' : 'B'}`)
        await real.write(p, c)
      },
    }
    const first = saveBoard({ path: 'Boards/Gate.md', text: a, expectedBase: base }, slowToJudge)
    const second = saveBoard({ path: 'Boards/Gate.md', text: b, expectedBase: base }, slowToJudge)
    expect(await first).toEqual({ ok: true })
    // The second was made from the base the first has since replaced: refused, nothing written.
    expect(await second).toMatchObject({ ok: false, changed: true })
    expect(log).toEqual(['write:A'])
    expect(await disk('Boards/Gate.md')).toBe(a)
  })

  it('and a save that names no note is refused at once, without waiting behind a slow one', async () => {
    const base = board()
    const a = edit(base, '- note x=1 y=1 w=100 size=18 color=ffffff fill= r=0 » A')
    const real = vault()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const stuck: BoardVault = { abs: (p) => real.abs(p), stat: (p) => real.stat(p), read: (p) => real.read(p), write: async (p, c) => { await gate; await real.write(p, c) } }
    const slow = saveBoard({ path: 'Boards/Gate.md', text: a, expectedBase: base }, stuck)
    expect(await saveBoard({ path: 5 as unknown as string, text: a }, stuck)).toMatchObject({ ok: false })
    expect(await saveBoard({ path: '../outside.md', text: a }, stuck)).toMatchObject({ ok: false })
    release()
    expect(await slow).toEqual({ ok: true })
  })
})

describe('a link to a note is no board to write to', () => {
  it.skipIf(process.platform === 'win32')('refuses a link inside the vault, whose write would replace the link with a copy (the real note would not change)', async () => {
    await fs.symlink(at('Boards/Gate.md'), at('Boards/alias.md'))
    const v = vault()
    const check = await checkBoard('Boards/alias.md', v)
    expect(check.ok).toBe(false)
    expect(check.ok ? '' : check.reason).toMatch(/is a link to a note/)
    expect(await readBoard('Boards/alias.md', v)).toBeNull()
    const res = await saveBoard({ path: 'Boards/alias.md', text: edit(board(), '- note x=0 y=0 w=1 size=1 color=ffffff fill= r=0 » x'), expectedBase: board() }, v)
    expect(res.ok).toBe(false)
    expect((await fs.lstat(at('Boards/alias.md'))).isSymbolicLink()).toBe(true)
    expect(await disk('Boards/Gate.md')).toBe(board())
    // The note itself is fine.
    expect(await checkBoard('Boards/Gate.md', v)).toEqual({ ok: true })
  })
})

describe('a note too long for the window is refused before a window exists, with its own sentence', () => {
  const pad = (n: number): string => board() + 'x'.repeat(n - board().length)

  it('has one limit for open, read and save: 1,000,000 characters of the whole note', async () => {
    expect(MAX_BOARD_TEXT).toBe(1_000_000)
    await put('Boards/Exact.md', pad(MAX_BOARD_TEXT))
    await put('Boards/Over.md', pad(MAX_BOARD_TEXT + 1))
    const v = vault()
    expect(await checkBoard('Boards/Exact.md', v)).toEqual({ ok: true })
    expect((await readBoard('Boards/Exact.md', v))?.length).toBe(MAX_BOARD_TEXT)
    const over = await checkBoard('Boards/Over.md', v)
    expect(over).toMatchObject({ ok: false })
    expect(over.ok ? '' : over.reason).toMatch(/Boards\/Over\.md is 1,000,001 characters long; the board window opens notes of up to 1,000,000 characters .* It stays in the app/)
    await expect(readBoard('Boards/Over.md', v)).rejects.toThrow(/1,000,001 characters long/)
    expect((await saveBoard({ path: 'Boards/Exact.md', text: pad(MAX_BOARD_TEXT + 1), expectedBase: pad(MAX_BOARD_TEXT) }, v)).ok).toBe(false)
  })

  it('a multi-byte note under the limit in characters is not "too long" for its size in bytes', async () => {
    const wide = board() + 'あ'.repeat(300_000) // 900,000 bytes of body, 300,000 characters
    await put('Boards/Wide.md', wide)
    expect(await checkBoard('Boards/Wide.md', vault())).toEqual({ ok: true })
    expect((await readBoard('Boards/Wide.md', vault()))?.length).toBe(wide.length)
  })

  it('judges a note of more than 4 bytes a character from its size alone, without reading it', async () => {
    await put('Boards/Huge.md', Buffer.concat([Buffer.from(board()), Buffer.alloc(MAX_BOARD_TEXT * 4 + 10, 0x78)]))
    const v = vault()
    const read = vi.spyOn(v, 'read')
    const res = await checkBoard('Boards/Huge.md', v)
    expect(res.ok ? '' : res.reason).toMatch(/is over 1,000,000 characters long/)
    expect(read).not.toHaveBeenCalled()
  })

  it('board:open refuses it, makes no window, and the message is not the one for a note that is gone', async () => {
    await put('Boards/Over.md', pad(MAX_BOARD_TEXT + 1))
    const t = rig()
    const handlers = boardHandlers({ host: t.host, vault: () => vault(), scan: () => null, ledger: new PictureLedger() })
    await expect(handlers.open('Boards/Over.md')).rejects.toThrow(/1,000,001 characters long.*It stays in the app/)
    await expect(handlers.open('Boards/Missing.md')).rejects.toThrow(/There is no note at/)
    await expect(handlers.open('Boards/Missing.md')).rejects.not.toThrow(/long/)
    expect(FakeWin.made).toHaveLength(0)
    expect(t.host.status().open).toBe(false)
    // A board that fits opens.
    expect((await handlers.open('Boards/Gate.md')).open).toBe(true)
  })
})

describe('a head the window cannot judge says so, instead of "it needs type: board"', () => {
  const nested = '---\ntitle: Nested\ntype: board\nmeta:\n  author: me\n---\n# Nested\n\n## Board\n'
  const manyTags = `---\ntitle: Tags\ntags:\n${Array.from({ length: 700 }, (_, i) => `  - tag-number-${i}`).join('\n')}\ntype: board\n---\n# Tags\n\n## Board\n`

  it('tells a note that is plainly no board from one it cannot read', async () => {
    expect(judgeBoardHead(board(), false)).toBe('yes')
    expect(judgeBoardHead('# no frontmatter\n', false)).toBe('no')
    expect(judgeBoardHead('---\ntitle: x\n---\n', false)).toBe('no')
    expect(judgeBoardHead('---\ntype: note\n---\n', false)).toBe('no')
    expect(judgeBoardHead(nested, false)).toBe('unsure')
    expect(judgeBoardHead('---\ntitle: x\ntype: board\n', true)).toBe('unsure')
    expect(judgeBoardHead('---\ntitle: x\ntype: board\n', false)).toBe('no')
    expect(boardNoteVerdict(nested)).toBe('unsure')
    expect(boardNoteVerdict(manyTags)).toBe('unsure')
    expect(boardNoteVerdict(board())).toBe('yes')
    // The yes/no of isBoardHead is the same as before: only a yes lets the window write.
    for (const t of [board(), nested, manyTags, '# x', '---\ntype: note\n---\n']) expect(isBoardHead(t)).toBe(judgeBoardHead(t, false) === 'yes')
  })

  it('says "cannot read the frontmatter" for a nested mapping and a very long one, "needs type: board" for a note that is none', async () => {
    await put('Boards/Nested.md', nested)
    await put('Boards/Tags.md', manyTags)
    // Core reads both as boards: the docked view opens them.
    expect(isBoardNote(nested)).toBe(true)
    expect(isBoardNote(manyTags)).toBe(true)
    const v = vault()
    for (const p of ['Boards/Nested.md', 'Boards/Tags.md']) {
      const res = await checkBoard(p, v)
      expect(res.ok, p).toBe(false)
      expect(res.ok ? '' : res.reason, p).toMatch(/cannot read the frontmatter of Boards\/.*\.md.*Open this board in the app instead/)
      expect(res.ok ? '' : res.reason, p).not.toMatch(/needs type: board/)
    }
    const plain = await checkBoard('Notes/Plain.md', v)
    expect(plain.ok ? '' : plain.reason).toMatch(/is not a board note \(it needs type: board in its frontmatter\)/)
  })

  it('says so about a save too, instead of calling its text "not a board"', async () => {
    const res = await saveBoard({ path: 'Boards/Gate.md', text: nested, expectedBase: board() }, vault())
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.reason).toMatch(/could not read again/)
    expect(res.ok ? '' : res.reason).not.toMatch(/missing from its frontmatter/)
    const lost = await saveBoard({ path: 'Boards/Gate.md', text: '# gone\n', expectedBase: board() }, vault())
    expect(lost.ok ? '' : lost.reason).toMatch(/type: board is missing/)
    expect(await disk('Boards/Gate.md')).toBe(board())
  })
})

describe('the frontmatter check trims what YAML trims (desktop-m1)', () => {
  it('does not take a no-break or narrow no-break space around the type for white space: core says no, so does the check', () => {
    for (const s of [' ', ' ', '　', ' ']) {
      for (const line of [`type: board${s}`, `type:${s}board`, `type: ${s}board`, `type: board ${s}`, `type: "board"${s}`]) {
        const head = `---\n${line}\n---\n# Body\n`
        expect(isBoardNote(head), JSON.stringify(line)).toBe(false)
        expect(isBoardHead(head), JSON.stringify(line)).toBe(false)
      }
    }
    // Spaces and tabs still are.
    expect(isBoardHead('---\ntype: board \t\n---\n')).toBe(true)
  })
})
