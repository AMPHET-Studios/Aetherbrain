import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardView } from '../src/board/BoardView'
import { BOARD_COMMANDS } from '../src/board/commands'
import { FakeHost, boardRaw } from './helpers/board-view-fakes'

/**
 * The view drawn as server markup, with no DOM: it must mount without a browser, show what a board shows before anything is done
 * (the toolbar, the status bar, the empty-board hint), do no work of its own (the host is not asked for anything), and say the
 * right thing when the board is not there yet or cannot be opened.
 */
const render = (host: FakeHost, props: { initialRaw?: string; className?: string } = {}) => renderToStaticMarkup(createElement(BoardView, { host, ...props }))

describe('the board view on a server', () => {
  it('an empty board: the toolbar, a canvas, the status bar and the hint to drop pictures', () => {
    const host = new FakeHost(boardRaw('Gate'), { window: true })
    const html = render(host, { initialRaw: host.raw })
    expect(html).toContain('<canvas')
    expect(html).toContain('Drop pictures here')
    expect(html).toContain('Add picture')
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Board status"')
    expect(html).toContain('>Gate<')
    expect(html).toContain('100%')
    expect(html).toContain('0 pictures')
    expect(html).toContain('0 / 1500 items')
    // No overlay is open.
    expect(html).not.toContain('role="menu"')
    expect(html).not.toContain('Add pictures to the board')
    expect(html).not.toContain('role="dialog"')
  })

  it('the status bar shows how much of its character budget the board has used: amber from 90 percent, red past it', () => {
    const empty = render(new FakeHost(boardRaw()), { initialRaw: boardRaw() })
    expect(empty).toMatch(/>\d+ of 500k characters</)
    expect(empty).not.toMatch(/class="[^"]*text-(inbox|danger)[^"]*" title="How much of the note[^>]*>/)
    // A note of 700 characters takes about 760 in the board section.
    const notes = (n: number) => boardRaw('Gate', [], Array.from({ length: n }, (_, i) => ['x'.repeat(700) + i, (i % 30) * 10, Math.floor(i / 30) * 10] as [string, number, number]))
    const cell = (n: number): string => {
      const h = render(new FakeHost(notes(n)), { initialRaw: notes(n) })
      return /<span class="([^"]*)" title="How much of the note[^>]*>(\d+k) of 500k characters</.exec(h)?.slice(1).join(' ') ?? 'missing'
    }
    expect(cell(560)).toMatch(/^whitespace-nowrap tabular-nums 4[12]\dk$/)
    expect(cell(600)).toMatch(/text-inbox 4[5-9]\dk$/)
    expect(cell(680)).toMatch(/text-danger 5\d\dk$/)
  })

  it('every tool is a button with its key in the tooltip', () => {
    const html = render(new FakeHost(boardRaw()), { initialRaw: boardRaw() })
    for (const c of BOARD_COMMANDS.filter((x) => x.group === 'Tools')) {
      expect(html, c.id).toContain(`aria-label="${c.title}"`)
      expect(html, c.id).toContain(`title="${c.title} (`)
    }
    expect(html).toContain('aria-pressed="true"')
  })

  it('a board with items has no hint, and says how many pictures and items there are', () => {
    const raw = boardRaw('Gate', [['a.png', 0, 0, 100, 100], ['b.png', 200, 0, 100, 100]], [['hi', 0, 200]])
    const html = render(new FakeHost(raw), { initialRaw: raw })
    expect(html).not.toContain('Drop pictures here</span>')
    expect(html).toContain('2 pictures')
    expect(html).toContain('3 / 1500 items')
  })

  it('the window controls follow the host: a docked board can pop out, a floating one can dock', () => {
    const docked = new FakeHost(boardRaw(), { window: true })
    expect(render(docked, { initialRaw: docked.raw })).toContain('Pop out')
    const floating = new FakeHost(boardRaw(), { window: true })
    floating.window!.floating = true
    const html = render(floating, { initialRaw: floating.raw })
    expect(html).toContain('Dock')
    expect(html).toContain('Always on top: on')
    expect(html).toContain('100%')
    expect(render(new FakeHost(boardRaw()), { initialRaw: boardRaw() })).not.toContain('Pop out')
  })

  it('without the note’s text it says it is opening, and asks the host for nothing while rendering', () => {
    const host = new FakeHost(boardRaw())
    const html = render(host)
    expect(html).toContain('Opening the board…')
    expect(html).not.toContain('<canvas')
    expect(host.loads).toBe(0)
    expect(host.previews).toEqual([])
    expect(host.toasts).toEqual([])
  })

  it('a note that is not a board shows why, with a way to try again', () => {
    const raw = '---\ntitle: Plain\n---\nProse.\n'
    const html = render(new FakeHost(raw), { initialRaw: raw })
    expect(html).toContain('This board did not open')
    expect(html).toContain('not a reference board')
    expect(html).toContain('Try again')
    expect(html).not.toContain('<canvas')
  })

  it('takes the caller’s class on its outer box, so the host app can place it', () => {
    const html = render(new FakeHost(boardRaw()), { initialRaw: boardRaw(), className: 'absolute inset-0' })
    expect(html).toMatch(/<div[^>]*data-board-root[^>]*class="[^"]*absolute inset-0/)
  })

  it('shows the missing-pictures notice and keeps their places when the vault lacks some', () => {
    const raw = boardRaw('Gate', [['gone/one.png', 0, 0, 100, 100]])
    const host = new FakeHost(raw)
    host.present = new Set()
    const html = render(host, { initialRaw: raw })
    expect(html).toContain('1 picture is')
    expect(html).toContain('missing from the vault')
    expect(html).toContain('one.png')
    expect(html).toContain('nothing is deleted')
  })

  it('writes nothing while rendering', () => {
    const host = new FakeHost(boardRaw())
    render(host, { initialRaw: host.raw })
    expect(host.saves).toEqual([])
    expect(host.externalSubs.size).toBe(0)
    expect(host.pictureSubs.size).toBe(0)
  })
})
