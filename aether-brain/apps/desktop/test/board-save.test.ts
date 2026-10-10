import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addNote, emptyBoard, isBoardNote, newBoardNote, parseBoard, serializeBoard, splitFrontmatter } from '@aether/core'
import type { VaultChangeDto } from '../src/shared/ipc.js'
import { FsVault } from '../src/main/fsvault.js'
import { VaultWatcher } from '../src/main/watcher.js'
import { BOARD_HEAD_BYTES, MAX_BOARD_PATH, MAX_BOARD_TEXT, checkBoard, isBoardHead, readBoard, saveBoard, validateBoardSave, type BoardVault } from '../src/main/board-save.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const NOW = new Date('2026-10-09T12:00:00Z')
const board = (title = 'Gate'): string => newBoardNote(title, NOW)
const PLAIN = '---\ntitle: Plain\n---\n# Plain\n\nJust a note.\n'

/* ------------------------------------------------------------------ */
/* isBoardHead                                                        */
/* ------------------------------------------------------------------ */

describe('isBoardHead', () => {
  const fm = (...lines: string[]): string => `---\n${lines.join('\n')}\n---\n# Body\n`

  it('accepts a frontmatter block with exactly one top-level `type: board`', () => {
    expect(isBoardHead(board())).toBe(true)
    expect(isBoardHead(fm('type: board'))).toBe(true)
    expect(isBoardHead(fm('title: x', 'type: board', 'tags: [a]'))).toBe(true)
    expect(isBoardHead(fm('type: "board"'))).toBe(true)
    expect(isBoardHead(fm("type: 'board'"))).toBe(true)
    expect(isBoardHead(fm('type:   board   '))).toBe(true)
    expect(isBoardHead(fm('type: board # the kind of note'))).toBe(true)
    expect(isBoardHead('---\r\ntitle: x\r\ntype: board\r\n---\r\n# Body')).toBe(true)
    expect(isBoardHead('﻿' + fm('type: board'))).toBe(true)
    expect(isBoardHead('---\ntype: board\n...\nbody')).toBe(true)
    expect(isBoardHead('---\ntype: board\n---')).toBe(true)
  })

  it('refuses everything else', () => {
    const no: Record<string, string> = {
      'no frontmatter': '# Gate\n\ntype: board\n',
      'a blank line before the block': '\n' + fm('type: board'),
      'an opening that is not exactly ---': '----\ntype: board\n---\n',
      'a block that never closes': '---\ntype: board\n# Gate\n',
      'another type': fm('type: note'),
      'a capital': fm('type: Board'),
      'a longer word': fm('type: boards'),
      'a hyphenated word': fm('type: board-ish'),
      'an indented (nested) type': fm('meta:', '  type: board'),
      'a repeated type (YAML refuses the block)': fm('type: board', 'type: board'),
      'a type of a note that is also something else': fm('type: board', 'type: project'),
      'any other repeated key (the block is unreadable as a whole)': fm('title: A', 'type: board', 'title: B'),
      'a repeated quoted key': fm('type: board', '"tags": [a]', 'tags: [b]'),
      'no space after the colon (a key of its own)': fm('type:board'),
      'a # glued to the word (a different word)': fm('type: board#x'),
      'a quote with trailing junk': fm('type: "board" x'),
      'a list': fm('type: [board]'),
      'an empty value': fm('type:'),
      'a comment line': fm('# type: board'),
      'the key in the body': '---\ntitle: x\n---\ntype: board\n',
      'empty text': '',
    }
    for (const [what, head] of Object.entries(no)) expect(isBoardHead(head), what).toBe(false)
  })

  it('never says yes where core says no, over thousands of odd frontmatters, and agrees on the ordinary ones', () => {
    // A small deterministic generator (mulberry32): the same blocks on every run.
    let seed = 0x9e3779b9
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pool = [
      'title: Gate', 'type: board', 'type: board # c', 'type: board #c', 'type: "board"', "type: 'board'", 'type:board', 'type: board#x', 'type: Board',
      'type: boards', '  type: board', 'type:  board  ', 'type:\tboard', 'type: [board]', 'type: !!str board', 'type: &a board', 'tags: [a, b]',
      'x: |', 'x: >-', 'notes: "a', 'type: board"', '# type: board', 'type: ', 'type: ~', 'type: null', '', ' ', '---', '...', 'type: board\r',
      '- type: board', '{type: board}', 'type: "board', "type: 'board'x", 'type: board \t', 'key: value', '? type', ': board', 'type: |\n  board',
      'title: Other', '"type": board', 'status: active',
    ]
    // Core gives up on a block whose YAML does not parse (it reads as no frontmatter at all): nothing to compare against there.
    const unreadable = (head: string): boolean => {
      const split = splitFrontmatter(head)
      return split.hasFrontmatter && Object.keys(split.frontmatter).length === 0 && head.slice(0, split.bodyOffset).split(/\r?\n/).slice(1).some((l) => !/^\s*(#.*|---|\.\.\.)?$/.test(l))
    }
    let readable = 0
    let boards = 0
    for (let i = 0; i < 5000; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pool[Math.floor(rand() * pool.length)]!)
      const eol = rand() < 0.2 ? '\r\n' : '\n'
      const head = `${rand() < 0.1 ? '\uFEFF' : ''}---${eol}${lines.join(eol)}${eol}---${eol}# Body${eol}`
      if (unreadable(head)) continue
      readable++
      const ours = isBoardHead(head)
      const core = isBoardNote(head)
      // The dangerous direction: the floating window would edit a note the brain does not call a board.
      expect(ours && !core, JSON.stringify(head)).toBe(false)
      if (core) boards++
      // Stricter than core is allowed only for the spellings a line check cannot follow: a tag or an anchor on the value, a quoted
      // key, a block written as one flow mapping.
      if (core && !ours) expect(head, 'a board this check misses').toMatch(/type: (!!|&)|"type"|'type'|\{/)
    }
    expect(readable).toBeGreaterThan(1000)
    expect(boards).toBeGreaterThan(300)
  })

  it('looks at a head of 4 KB: the check after a write sees what the check before it did', () => {
    expect(BOARD_HEAD_BYTES).toBe(4096)
    // A block whose closing --- is past the head is no board, however it ends.
    const long = `---\ntitle: ${'x'.repeat(BOARD_HEAD_BYTES)}\ntype: board\n---\n`
    expect(isBoardHead(long.slice(0, BOARD_HEAD_BYTES))).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* A temp vault                                                       */
/* ------------------------------------------------------------------ */

let tmp: string
let root: string
let outside: string

const at = (rel: string): string => path.join(root, ...rel.split('/'))
async function put(rel: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(at(rel)), { recursive: true })
  await fs.writeFile(at(rel), content)
}
const disk = (rel: string): Promise<string> => fs.readFile(at(rel), 'utf8')
const files = async (dir: string): Promise<string[]> => (await fs.readdir(at(dir))).sort()

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-board-save-'))
  root = path.join(tmp, 'vault')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await put('Boards/Gate.md', board('Gate'))
  await put('Notes/Plain.md', PLAIN)
  await put('Boards/Gate/rust.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  await put('Boards/Not a note.txt', board('Txt'))
  await fs.mkdir(at('Boards/Folder.md'), { recursive: true })
  await put('node_modules/pkg/Board.md', board('Ignored'))
  await fs.writeFile(path.join(outside, 'Secret.md'), board('Secret'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

const vault = (): FsVault => new FsVault([root])

describe('checkBoard and validateBoardSave', () => {
  it('say yes only for a board note that is there, and no for each other thing, with a reason', async () => {
    const v = vault()
    await expect(checkBoard('Boards/Gate.md', v)).resolves.toEqual({ ok: true })
    const refused: [string, unknown, RegExp][] = [
      ['a note that is not a board', 'Notes/Plain.md', /not a board note/],
      ['a missing file', 'Boards/Missing.md', /There is no note at/],
      ['a folder named like a note', 'Boards/Folder.md', /There is no note at/],
      ['a path that leaves the vault', '../outside/Secret.md', /Not a path inside the vault/],
      ['a deeper way out', 'Boards/../../outside/Secret.md', /Not a path inside the vault/],
      ['a file that is not markdown', 'Boards/Not a note.txt', /Only markdown notes/],
      ['a picture', 'Boards/Gate/rust.png', /Only markdown notes/],
      ['a note in a folder the vault ignores', 'node_modules/pkg/Board.md', /There is no note at/],
      ['an empty path', '', /empty or too long/],
      ['a blank path', '   ', /empty or too long/],
      ['a path with a NUL', 'Boards/Gate.md\0.txt', /empty or too long|Only markdown/],
      ['a path that is far too long', `Boards/${'a'.repeat(MAX_BOARD_PATH)}.md`, /empty or too long/],
      ['a number', 42, /must be text/],
      ['null', null, /must be text/],
      ['an object', { toString: () => 'Boards/Gate.md' }, /must be text/],
    ]
    for (const [what, p, reason] of refused) {
      const res = await checkBoard(p, v)
      expect(res.ok, what).toBe(false)
      expect(res.ok ? '' : res.reason, what).toMatch(reason)
    }
  })

  it('refuse everything when no vault is open', async () => {
    expect(await checkBoard('Boards/Gate.md', null)).toEqual({ ok: false, reason: 'No vault is open' })
    expect(await validateBoardSave({ path: 'Boards/Gate.md', text: board() }, null)).toEqual({ ok: false, reason: 'No vault is open' })
    expect(await saveBoard({ path: 'Boards/Gate.md', text: board() }, null)).toEqual({ ok: false, reason: 'No vault is open' })
    expect(await readBoard('Boards/Gate.md', null)).toBeNull()
  })

  it('refuse a symlink that leads out of the vault (a board note out there is not this vault\'s)', async () => {
    try {
      await fs.symlink(path.join(outside, 'Secret.md'), at('Boards/Link.md'))
    } catch {
      return // no symlinks here (Windows without developer mode)
    }
    const res = await checkBoard('Boards/Link.md', vault())
    expect(res.ok).toBe(false)
    expect(await readBoard('Boards/Link.md', vault())).toBeNull()
    expect((await saveBoard({ path: 'Boards/Link.md', text: board('Hijack') }, vault())).ok).toBe(false)
    expect(await fs.readFile(path.join(outside, 'Secret.md'), 'utf8')).toBe(board('Secret'))
  })

  it('takes a save of at most 400,000 characters whose own head is a board', async () => {
    const v = vault()
    const pad = (n: number): string => board() + 'x'.repeat(n - board().length)
    expect(MAX_BOARD_TEXT).toBe(400_000)
    expect(pad(MAX_BOARD_TEXT).length).toBe(MAX_BOARD_TEXT)
    await expect(validateBoardSave({ path: 'Boards/Gate.md', text: pad(MAX_BOARD_TEXT) }, v)).resolves.toEqual({ ok: true })
    const over = await validateBoardSave({ path: 'Boards/Gate.md', text: pad(MAX_BOARD_TEXT + 1) }, v)
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.reason).toMatch(/longer than 400,000 characters/)
    const refused: [string, unknown][] = [
      ['a note that lost its frontmatter', '# Gate\n\n## Board\n- view x=0 y=0 zoom=1\n'],
      ['a note of another type', PLAIN],
      ['text that is not text', 12345],
      ['nothing', undefined],
      ['bytes', new Uint8Array([1, 2, 3])],
      ['an empty text', ''],
    ]
    for (const [what, text] of refused) {
      const res = await validateBoardSave({ path: 'Boards/Gate.md', text }, v)
      expect(res.ok, what).toBe(false)
    }
  })

  it('judges the head of a save in bytes, as the next read will: a long non-ASCII title cannot hide `type: board` past the first 4 KB', async () => {
    // 1,400 characters (4,200 bytes) of title: the closing --- is inside the first 4,096 *characters* but beyond the first 4,096 *bytes*.
    const title = 'あ'.repeat(1400)
    const text = `---\ntitle: ${title}\ntype: board\n---\n# x\n`
    expect(text.indexOf('type: board')).toBeLessThan(BOARD_HEAD_BYTES)
    expect(Buffer.byteLength(text.slice(0, text.indexOf('type: board')))).toBeGreaterThan(BOARD_HEAD_BYTES)
    const res = await validateBoardSave({ path: 'Boards/Gate.md', text }, vault())
    expect(res.ok).toBe(false)
    // Written anyway it would never open again: readBoard (which reads the file's first 4,096 bytes) would find no board.
    await put('Boards/Wide.md', text)
    expect(await readBoard('Boards/Wide.md', vault())).toBeNull()
    // The same title at 1,300 characters (3,900 bytes) leaves room for the key and is a board both ways.
    const ok = `---\ntitle: ${'あ'.repeat(1300)}\ntype: board\n---\n# x\n`
    expect((await validateBoardSave({ path: 'Boards/Gate.md', text: ok }, vault())).ok).toBe(true)
    await put('Boards/Narrower.md', ok)
    expect(await readBoard('Boards/Narrower.md', vault())).toBe(ok)
  })
})

describe('saveBoard', () => {
  it('overwrites an existing board note with the new text, atomically, and leaves nothing else behind', async () => {
    const v = vault()
    const before = await files('Boards')
    const next = serializeBoard(addNote(parseBoard(board()).doc, { text: 'Check the edge of the lintel' }).doc, board(), NOW)
    expect(next).not.toBe(board())
    await expect(saveBoard({ path: 'Boards/Gate.md', text: next }, v)).resolves.toEqual({ ok: true })
    expect(await disk('Boards/Gate.md')).toBe(next)
    // No temp sibling of the atomic write is left, and no other file appeared.
    expect(await files('Boards')).toEqual(before)
    const again = next.replace('Check the edge', 'Check the whole edge')
    await expect(saveBoard({ path: 'Boards/Gate.md', text: again }, v)).resolves.toEqual({ ok: true })
    expect(await disk('Boards/Gate.md')).toBe(again)
    expect(await files('Boards')).toEqual(before)
  })

  it('never creates a note, however the path is spelled', async () => {
    const v = vault()
    for (const p of ['Boards/New.md', 'New.md', 'Boards/Sub/New.md', 'boards/gate2.md']) {
      const res = await saveBoard({ path: p, text: board('New') }, v)
      expect(res.ok, p).toBe(false)
    }
    expect(await files('Boards')).toEqual(['Folder.md', 'Gate', 'Gate.md', 'Not a note.txt'])
    expect(await fs.readdir(root)).not.toContain('New.md')
  })

  it('writes nothing when it refuses: every other note, the folder and the files outside stay byte for byte', async () => {
    const v = vault()
    const snapshot = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {}
      const walk = async (dir: string): Promise<void> => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) await walk(full)
          else out[path.relative(tmp, full)] = (await fs.readFile(full)).toString('base64')
        }
      }
      await walk(tmp)
      return out
    }
    const before = await snapshot()
    const attempts: [unknown, unknown][] = [
      ['Notes/Plain.md', board('Hijack')],
      ['Boards/Gate.md', PLAIN],
      ['Boards/Gate.md', board() + 'x'.repeat(MAX_BOARD_TEXT)],
      ['Boards/Gate.md', 7],
      ['Boards/Not a note.txt', board('Hijack')],
      ['Boards/Gate/rust.png', board('Hijack')],
      ['../outside/Secret.md', board('Hijack')],
      ['node_modules/pkg/Board.md', board('Hijack')],
      ['Boards/Folder.md', board('Hijack')],
      [null, board('Hijack')],
      ['Boards/Gate.md\0', board('Hijack')],
    ]
    for (const [p, text] of attempts) expect((await saveBoard({ path: p, text }, v)).ok, String(p)).toBe(false)
    expect(await snapshot()).toEqual(before)
  })

  it('says why a write failed in words, without the disk path', async () => {
    const real = vault()
    const failing = (code: string, message: string): BoardVault => ({
      abs: (p) => real.abs(p),
      stat: (p) => real.stat(p),
      read: (p) => real.read(p),
      write: async () => {
        throw Object.assign(new Error(message), { code })
      },
    })
    const dto = { path: 'Boards/Gate.md', text: board() }
    const denied = await saveBoard(dto, failing('EACCES', `EACCES: permission denied, open '${at('Boards/Gate.md')}'`))
    expect(denied).toEqual({ ok: false, reason: 'The board file cannot be written (permission denied or read-only)' })
    expect(await saveBoard(dto, failing('EROFS', 'x'))).toMatchObject({ ok: false, reason: expect.stringMatching(/read-only/) })
    expect(await saveBoard(dto, failing('ENOSPC', `ENOSPC at ${tmp}`))).toEqual({ ok: false, reason: 'The disk is full' })
    const other = await saveBoard(dto, failing('EIO', `first line\nsecond ${tmp}`))
    expect(other).toEqual({ ok: false, reason: 'The board could not be written: first line' })
    // A message of any length stays one short line.
    const long = await saveBoard(dto, failing('EIO', 'y'.repeat(5000)))
    expect(long.ok ? '' : long.reason.length).toBeLessThan(220)
  })

  it('is reported by the file watcher like an edit made outside the app (the note is not announced as our own write)', async () => {
    const v = vault()
    const scan = await v.scan()
    const seen: VaultChangeDto[] = []
    const watcher = new VaultWatcher(v, { files: scan.files.map((f) => f.path), folders: scan.folders, images: scan.assets.map((a) => a.path) }, (batch) => seen.push(...batch), {
      debounceMs: 40,
    })
    const noted = vi.spyOn(watcher, 'noteSelfWrite')
    try {
      await watcher.start()
      // The native watcher is armed once it has seen a probe write.
      for (let i = 0; !seen.some((c) => c.path === 'probe.md'); i++) {
        if (i > 60) throw new Error('watcher never became ready')
        await fs.writeFile(at('probe.md'), `probe ${i}`)
        await new Promise((r) => setTimeout(r, 80))
      }
      seen.length = 0
      const text = serializeBoard(addNote(parseBoard(board()).doc, { text: 'seen by the brain' }).doc, board(), NOW)
      await expect(saveBoard({ path: 'Boards/Gate.md', text }, v)).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(seen.find((c) => c.path === 'Boards/Gate.md')).toMatchObject({ kind: 'change', content: text }), { timeout: 4000 })
      expect(noted).not.toHaveBeenCalled()

      // The control: the same write announced the way the brain window's own note writer does is swallowed, which is what this
      // test would show if a save ever began to announce itself.
      seen.length = 0
      const own = text.replace('seen by the brain', 'announced first')
      watcher.noteSelfWrite('Boards/Gate.md', own)
      await v.write('Boards/Gate.md', own)
      await new Promise((r) => setTimeout(r, 400))
      expect(seen.filter((c) => c.path === 'Boards/Gate.md')).toEqual([])
    } finally {
      watcher.stop()
    }
  })

  it('wires board:save, board:read and board:open in main.ts to the checked functions only, never announcing a write', async () => {
    const src = await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8')
    const win = await fs.readFile(path.join(here, '..', 'src', 'main', 'board-window.ts'), 'utf8')
    const wiring = /function registerBoardIpc[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
    expect(wiring).toContain('IPC.boardSave')
    expect(wiring).toContain('h.save(p, text)')
    expect(wiring).toContain('h.read(p)')
    expect(wiring).not.toMatch(/noteSelfWrite|readNote|writeNote|createNote|vault\.write/)
    // The handlers get no watcher to announce anything to, and go through board-save.ts for every vault access.
    const handlers = /export function boardHandlers[\s\S]*?\n}\n/.exec(win)?.[0] ?? ''
    expect(handlers).toContain('saveBoard(')
    expect(handlers).toContain('readBoard(')
    expect(handlers).toContain('checkBoard(')
    expect(handlers).not.toMatch(/noteSelfWrite|\.write\(|\.read\(/)
  })
})

describe('readBoard', () => {
  it('serves a board note, and only a board note', async () => {
    const v = vault()
    expect(await readBoard('Boards/Gate.md', v)).toBe(board('Gate'))
    const nothing: unknown[] = [
      'Notes/Plain.md',
      'Boards/Missing.md',
      'Boards/Folder.md',
      '../outside/Secret.md',
      'Boards/Not a note.txt',
      'Boards/Gate/rust.png',
      'node_modules/pkg/Board.md',
      '',
      7,
      null,
      'Boards/Gate.md\0',
    ]
    for (const p of nothing) expect(await readBoard(p, v), String(p)).toBeNull()
  })

  it('does not serve a board the window could not save back: over 400,000 characters, or too many bytes to be that few', async () => {
    const v = vault()
    const pad = (n: number): string => board() + 'x'.repeat(n - board().length)
    await put('Boards/Exact.md', pad(MAX_BOARD_TEXT))
    expect((await readBoard('Boards/Exact.md', v))?.length).toBe(MAX_BOARD_TEXT)
    await put('Boards/Over.md', pad(MAX_BOARD_TEXT + 1))
    expect(await readBoard('Boards/Over.md', v)).toBeNull()
    // Far more bytes than 4 per character of the cap: refused from its size, without being read.
    await put('Boards/Huge.md', Buffer.concat([Buffer.from(board()), Buffer.alloc(MAX_BOARD_TEXT * 4 + 10, 0x78)]))
    const spy = vi.spyOn(v, 'read')
    expect(await readBoard('Boards/Huge.md', v)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('round trips with core: read, change the board, save, read again, the rest of the note untouched', async () => {
    const v = vault()
    const hand = board('Gate').replace('Reference board.', 'My own words about this board, kept as they are.') + '\n## Later\n\nA paragraph below the board.\n'
    await put('Boards/Gate.md', hand)
    const raw = await readBoard('Boards/Gate.md', v)
    expect(raw).toBe(hand)
    expect(isBoardNote(raw!)).toBe(true)
    const doc = parseBoard(raw!).doc
    const edited = addNote(addNote(doc, { text: 'one' }).doc, { text: 'two [sic]' }).doc
    const next = serializeBoard(edited, raw!, NOW)
    expect(await saveBoard({ path: 'Boards/Gate.md', text: next }, v)).toEqual({ ok: true })
    const back = await readBoard('Boards/Gate.md', v)
    expect(back).toBe(next)
    expect(parseBoard(back!).doc.items.map((i) => (i.kind === 'note' ? i.text : ''))).toEqual(['one', 'two [sic]'])
    expect(back).toContain('My own words about this board, kept as they are.')
    expect(back!.endsWith('## Later\n\nA paragraph below the board.\n')).toBe(true)
    // A fresh empty board saves as it is.
    expect(parseBoard(await readBoard('Boards/Gate.md', v) as string).doc.title).toBe(emptyBoard('Gate').title)
  })
})
