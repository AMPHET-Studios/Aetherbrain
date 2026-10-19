import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lf } from './helpers/lf'

/**
 * Clicks that landed on nothing. Two layers of the window took clicks they had no business with, and made icons "do nothing":
 *  - the strip along the bottom (the legend and the hint) took the mouse across the whole window, so a quarter of the 3D view could
 *    not be clicked, hovered, dragged or zoomed;
 *  - the full-window views (Capture, Review, Projects, Boards) covered the top bar, so the first click on any of its tabs or buttons only
 *    closed the view.
 * These are layout facts of the source (the pages have no DOM test here), pinned so a change cannot undo them quietly.
 */

const read = (p: string) => lf(readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'))
/** The z-index of the first element whose class list contains `marker`, from its `z-30` or `z-[35]` class. */
const layer = (source: string, marker: string): number => {
  const classes = source.match(new RegExp(`className="([^"]*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*)"`))?.[1] ?? ''
  const z = classes.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/)
  return z ? Number(z[1] ?? z[2]) : Number.NaN
}

describe('the strip along the bottom', () => {
  const app = read('App.tsx')

  it('lets the mouse through between the legend and the hint', () => {
    const row = app.match(/<div className="([^"]*)">\s*<div className="pointer-events-auto">\s*<ErrorBoundary what="the legend"/)?.[1] ?? ''
    expect(row).toContain('pointer-events-none')
    expect(row).not.toContain('pointer-events-auto')
  })

  it('takes the mouse only on the legend and on the hint themselves', () => {
    expect(app).toMatch(/<div className="pointer-events-auto">\s*<ErrorBoundary what="the legend" quiet>/)
    expect(app).toMatch(/<div className="pointer-events-auto">\s*<ErrorBoundary what="the hint" quiet>/)
  })
})

describe('the inspector’s box', () => {
  it('is only as tall as the inspector, so it takes the mouse nowhere else', () => {
    // A box stretched to the whole row (the default) took the mouse over the empty space under a short inspector.
    expect(read('App.tsx')).toMatch(/<div className="pointer-events-auto flex max-h-full items-start self-start">\s*<ErrorBoundary what="the inspector"/)
  })
})

describe('the top bar and the full-window views', () => {
  const bar = layer(read('App.tsx'), 'pointer-events-auto relative')
  const views: [string, number][] = [
    ['Capture', layer(read('components/Capture.tsx'), 'absolute inset-0')],
    ['Review', layer(read('components/Review.tsx'), 'absolute inset-0')],
    ['Projects', layer(read('components/ProjectsView.tsx'), 'absolute inset-0')],
    ['Boards', layer(read('board/BoardsView.tsx'), 'absolute inset-0')],
  ]

  it('keeps the bar above every view, so its tabs and buttons work on the first click', () => {
    expect(Number.isNaN(bar)).toBe(false)
    for (const [name, z] of views) {
      expect(Number.isNaN(z), name).toBe(false)
      expect(bar, `the top bar over ${name}`).toBeGreaterThan(z)
    }
  })

  it('keeps the search, the cheatsheet and the crash notice above the bar', () => {
    expect(layer(read('components/CommandPalette.tsx'), 'absolute inset-0')).toBeGreaterThan(bar)
    expect(layer(read('components/Help.tsx'), 'absolute inset-0')).toBeGreaterThan(bar)
    expect(layer(read('components/ErrorBoundary.tsx'), 'fixed inset-0')).toBeGreaterThan(bar)
  })

  it('starts each view’s panel below the bar, so nothing of it hides under the bar', () => {
    expect(read('components/ProjectsView.tsx')).toMatch(/absolute inset-0 z-30[^"]*pt-16/)
    expect(read('board/BoardsView.tsx')).toMatch(/absolute inset-0 z-30[^"]*pt-16/)
    // Review's panel hung from the top of the window: it now leaves room for the bar like the others.
    expect(read('components/Review.tsx')).toMatch(/className="panel rise mx-3 mb-3 mt-16 /)
    // Capture is a dialog in the upper middle, well under the bar.
    expect(read('components/Capture.tsx')).toMatch(/absolute inset-0 z-30[^"]*pt-\[14vh\]/)
  })
})

describe('the keyboard guide', () => {
  it('says what the icons do', () => {
    const guide = lf(readFileSync(new URL('../../../docs/KEYBOARD.md', import.meta.url), 'utf8'))
    expect(guide).toContain('**Every icon does something.**')
    expect(guide).toContain('click one to light up everything of that kind')
    expect(guide).toContain('The round logo at the top left brings you back to the graph')
    expect(guide).toContain('the 3D view takes the mouse everywhere the legend and the panels do not')
  })
})
