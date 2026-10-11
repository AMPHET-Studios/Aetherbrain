import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, addNote, addPicture, emptyBoard, estimateTextMetrics, type BoardDoc } from '@aether/core'
import {
  EXPORT_TARGET_SIDE,
  MAX_DROP_FILES,
  MAX_FILE_BYTES,
  RETRY_FIRST_MS,
  SAVE_THROTTLE_MS,
  Saver,
  VIEW_KEY_PREFIX,
  classifyTransfer,
  describePicture,
  exportFileName,
  exportScale,
  formatKeys,
  formatZoom,
  hexOfPixel,
  htmlHasImage,
  infoRows,
  isImageFile,
  parseHexInput,
  readStoredView,
  summarizeSelection,
  toolHint,
  uriListHasAddress,
  writeStoredView,
  type FileLike,
} from '../src/board/view/session'
import { FakeTimers, MemoryStorage, settle } from './helpers/board-view-fakes'

/** The save scheduler on a clock that moves only when told, with a write that takes as long as the test says. */
function saverRig(opts: { writeMs?: number } = {}) {
  const timers = new FakeTimers()
  const log: string[] = []
  let running = 0
  let maxRunning = 0
  let fail: Error | null = null
  const state = { writes: 0, errors: [] as boolean[], views: 0, statuses: 0 }
  const saver = new Saver({
    timers,
    run: async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      log.push(`start@${timers.t - 1_000_000}`)
      try {
        if (opts.writeMs) await new Promise<void>((r) => timers.set(r, opts.writeMs!))
        if (fail) throw fail
        state.writes++
        log.push(`end@${timers.t - 1_000_000}`)
      } finally {
        running--
      }
    },
    onError: (_e, first) => state.errors.push(first),
    persistView: () => void state.views++,
    onStatus: () => void state.statuses++,
  })
  return {
    saver,
    timers,
    log,
    state,
    maxRunning: () => maxRunning,
    failWith: (e: Error | null) => void (fail = e),
  }
}

describe('Saver', () => {
  it('a change in the middle of a gesture is written once a second, counted from the first one', async () => {
    const r = saverRig()
    r.saver.note({ final: false, viewOnly: false })
    await r.timers.advance(400)
    r.saver.note({ final: false, viewOnly: false })
    await r.timers.advance(400)
    r.saver.note({ final: false, viewOnly: false })
    expect(r.state.writes).toBe(0)
    await r.timers.advance(SAVE_THROTTLE_MS - 800 + 1)
    expect(r.state.writes).toBe(1)
    expect(r.saver.dirty).toBe(false)
  })

  it('the end of a gesture is written at once, and drops the wait that was running', async () => {
    const r = saverRig()
    r.saver.note({ final: false, viewOnly: false })
    expect(r.timers.pending).toBe(1)
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.state.writes).toBe(1)
    expect(r.timers.pending).toBe(0)
    await r.timers.advance(5000)
    expect(r.state.writes).toBe(1)
  })

  it('a view-only change never writes, and the camera is remembered once the moves stop for a moment', async () => {
    const r = saverRig()
    for (let i = 0; i < 20; i++) {
      r.saver.note({ final: true, viewOnly: true })
      await r.timers.advance(50)
    }
    expect(r.state.writes).toBe(0)
    expect(r.saver.dirty).toBe(false)
    // Twenty pans over a second: remembered a few times, not twenty.
    expect(r.state.views).toBeGreaterThan(0)
    expect(r.state.views).toBeLessThan(6)
  })

  it('writes never overlap: what arrives during a write is written after it, once', async () => {
    const r = saverRig({ writeMs: 300 })
    r.saver.note({ final: true, viewOnly: false })
    await r.timers.advance(100)
    r.saver.note({ final: true, viewOnly: false })
    r.saver.note({ final: true, viewOnly: false })
    r.saver.note({ final: true, viewOnly: false })
    await r.timers.advance(2000)
    expect(r.maxRunning()).toBe(1)
    expect(r.state.writes).toBe(2)
    expect(r.saver.dirty).toBe(false)
    expect(r.saver.running).toBe(false)
  })

  it('changes made mid-gesture during a write wait for the throttle, not for the end of the write', async () => {
    const r = saverRig({ writeMs: 200 })
    r.saver.note({ final: true, viewOnly: false })
    await r.timers.advance(50)
    r.saver.note({ final: false, viewOnly: false })
    await r.timers.advance(200)
    expect(r.state.writes).toBe(1)
    expect(r.saver.dirty).toBe(true)
    await r.timers.advance(SAVE_THROTTLE_MS + 300)
    expect(r.state.writes).toBe(2)
  })

  it('flush writes what is pending now and resolves when it is on disk; with nothing pending it does nothing', async () => {
    const r = saverRig({ writeMs: 100 })
    await r.saver.flush()
    expect(r.state.writes).toBe(0)
    r.saver.note({ final: false, viewOnly: false })
    const p = r.saver.flush()
    let done = false
    void p.then(() => (done = true))
    await settle()
    expect(done).toBe(false)
    await r.timers.advance(100)
    await p
    expect(r.state.writes).toBe(1)
    expect(r.timers.pending).toBe(0)
  })

  it('flush also remembers a camera move that was waiting', async () => {
    const r = saverRig()
    r.saver.note({ final: true, viewOnly: true })
    expect(r.state.views).toBe(0)
    await r.saver.flush()
    expect(r.state.views).toBe(1)
    await r.timers.advance(1000)
    expect(r.state.views).toBe(1)
  })

  it('a write that fails keeps the board dirty and says so once; the retry waits 5 s and doubles; success clears it', async () => {
    const r = saverRig()
    r.failWith(new Error('nope'))
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.saver.failing).toBe(true)
    expect(r.saver.dirty).toBe(true)
    expect(r.state.errors).toEqual([true])
    await r.timers.advance(RETRY_FIRST_MS + 1)
    expect(r.state.errors).toEqual([true, false])
    // The second wait is twice as long.
    await r.timers.advance(RETRY_FIRST_MS + 1)
    expect(r.state.errors).toEqual([true, false])
    await r.timers.advance(RETRY_FIRST_MS)
    expect(r.state.errors).toEqual([true, false, false])
    r.failWith(null)
    await r.timers.advance(40_000)
    expect(r.saver.failing).toBe(false)
    expect(r.saver.dirty).toBe(false)
    expect(r.state.writes).toBe(1)
    // The next failure is news again.
    r.failWith(new Error('again'))
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.state.errors.at(-1)).toBe(true)
  })

  it('flush tries a failing write once more and gives up for now, resolving', async () => {
    const r = saverRig()
    r.failWith(new Error('nope'))
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    const errors = r.state.errors.length
    await r.saver.flush()
    expect(r.state.errors.length).toBe(errors + 1)
    expect(r.saver.dirty).toBe(true)
  })

  it('stop cancels every timer', async () => {
    const r = saverRig()
    r.saver.note({ final: false, viewOnly: false })
    r.saver.note({ final: true, viewOnly: true })
    expect(r.timers.pending).toBe(2)
    r.saver.stop()
    expect(r.timers.pending).toBe(0)
  })
})

describe('the camera’s memory', () => {
  const path = 'Boards/Gate.md'
  it('round-trips a camera and keys it by the board’s path', () => {
    const s = new MemoryStorage()
    expect(writeStoredView(s, path, { x: 12.5, y: -3, zoom: 0.25 })).toBe(true)
    expect(s.map.has(VIEW_KEY_PREFIX + path)).toBe(true)
    expect(readStoredView(s, path)).toEqual({ x: 12.5, y: -3, zoom: 0.25 })
    expect(readStoredView(s, 'Boards/Other.md')).toBeNull()
  })

  it('bad JSON, wrong shapes, numbers that are no camera: null, never a throw', () => {
    const s = new MemoryStorage()
    const put = (v: string) => s.setItem(VIEW_KEY_PREFIX + path, v)
    for (const bad of ['', '{', 'null', '[]', '"x"', '{"x":1,"y":2}', '{"x":"1","y":2,"zoom":1}', '{"x":1,"y":2,"zoom":0}', `{"x":1,"y":2,"zoom":${BOARD_LIMITS.zoomMax * 2}}`, '{"x":1e99,"y":2,"zoom":1}', '{"x":null,"y":2,"zoom":1}']) {
      put(bad)
      expect(readStoredView(s, path), bad).toBeNull()
    }
  })

  it('a storage that throws, or none at all, is no camera and no crash', () => {
    const thrower = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('quota')
      },
    }
    expect(readStoredView(thrower, path)).toBeNull()
    expect(writeStoredView(thrower, path, { x: 0, y: 0, zoom: 1 })).toBe(false)
    expect(readStoredView(null, path)).toBeNull()
    expect(writeStoredView(null, path, { x: 0, y: 0, zoom: 1 })).toBe(false)
  })
})

const f = (name: string, type = '', size = 1000): FileLike => ({ name, type, size })

describe('what a drop or a paste carries', () => {
  it('picture files are told by type or by extension; SVG and other files are not pictures', () => {
    for (const ok of [f('a.png'), f('a.JPG'), f('a.jpeg'), f('a.webp'), f('a.gif'), f('a.bmp'), f('a.avif'), f('image', 'image/png'), f('x', 'image/jpeg'), f('x', 'image/x-ms-bmp'), f('x', 'image/avif')]) {
      expect(isImageFile(ok), ok.name + ok.type).toBe(true)
    }
    for (const no of [f('a.svg', 'image/svg+xml'), f('a.txt', 'text/plain'), f('a.pdf', 'application/pdf'), f('movie.mp4', 'video/mp4'), f('png'), f('x', 'image/tiff')]) {
      expect(isImageFile(no), no.name + no.type).toBe(false)
    }
  })

  it('files first: pictures, with what was left out and why', () => {
    const plan = classifyTransfer({ files: [f('a.png'), f('b.txt'), f('c.jpg'), f('big.png', 'image/png', MAX_FILE_BYTES + 1)], uriList: 'https://x/y.png', html: '<img src="x">', text: 'hi' })
    expect(plan.kind).toBe('files')
    if (plan.kind !== 'files') return
    expect(plan.pictures.map((p) => p.name)).toEqual(['a.png', 'c.jpg'])
    expect(plan.ignored).toBe(1)
    expect(plan.tooBig.map((p) => p.name)).toEqual(['big.png'])
    expect(plan.overCap).toBe(0)
  })

  it('a file of exactly 40 MB is taken; at most 40 files a drop, the rest counted', () => {
    const exact = classifyTransfer({ files: [f('a.png', '', MAX_FILE_BYTES)], uriList: '', html: '', text: '' })
    expect(exact.kind === 'files' && exact.pictures.length).toBe(1)
    const many = Array.from({ length: MAX_DROP_FILES + 7 }, (_, i) => f(`${i}.png`))
    const plan = classifyTransfer({ files: many, uriList: '', html: '', text: '' })
    expect(plan.kind === 'files' && plan.pictures.length).toBe(MAX_DROP_FILES)
    expect(plan.kind === 'files' && plan.overCap).toBe(7)
    expect(plan.kind === 'files' && plan.pictures[MAX_DROP_FILES - 1]!.name).toBe(`${MAX_DROP_FILES - 1}.png`)
  })

  it('files that are all non-pictures are still a files plan with nothing to add (the user is told)', () => {
    const plan = classifyTransfer({ files: [f('a.txt'), f('b.zip')], uriList: '', html: '', text: '' })
    expect(plan).toMatchObject({ kind: 'files', pictures: [], ignored: 2 })
  })

  it('an address or an <img src> with no file is the no-network case, even next to text', () => {
    expect(classifyTransfer({ files: [], uriList: 'https://example.com/a.png\r\n', html: '', text: 'https://example.com/a.png' }).kind).toBe('url')
    expect(classifyTransfer({ files: [], uriList: '# a comment\r\n', html: '', text: 'plain' }).kind).toBe('text')
    expect(classifyTransfer({ files: [], uriList: '', html: '<p>hi <img class="x" src="https://e/a.png"></p>', text: 'hi' }).kind).toBe('url')
    expect(classifyTransfer({ files: [], uriList: '', html: '<p>just <b>rich</b> text</p>', text: 'just rich text' }).kind).toBe('text')
  })

  it('plain text is a note, with line breaks normalised and cut to what a note holds', () => {
    const plan = classifyTransfer({ files: [], uriList: '', html: '', text: 'a\r\nb\rc' })
    expect(plan).toEqual({ kind: 'text', text: 'a\nb\nc', truncated: false })
    const long = classifyTransfer({ files: [], uriList: '', html: '', text: 'z'.repeat(BOARD_LIMITS.noteChars + 1) })
    expect(long.kind === 'text' && long.text.length).toBe(BOARD_LIMITS.noteChars)
    expect(long.kind === 'text' && long.truncated).toBe(true)
  })

  it('nothing usable: white space, or nothing at all', () => {
    expect(classifyTransfer({ files: [], uriList: '', html: '', text: '  \n\t ' }).kind).toBe('nothing')
    expect(classifyTransfer({ files: [], uriList: '', html: '<div></div>', text: '' }).kind).toBe('nothing')
  })

  it('the pieces: img tags are found by their src, address lists by a line that is not a comment', () => {
    expect(htmlHasImage('<IMG SRC=x>')).toBe(true)
    expect(htmlHasImage('<img alt="no source">')).toBe(false)
    expect(htmlHasImage('<imgx src="a">')).toBe(false)
    expect(uriListHasAddress('\n\n# c\n')).toBe(false)
    expect(uriListHasAddress('# c\nfile:///a.png')).toBe(true)
  })
})

describe('what the bars say', () => {
  it('keys are written in the platform’s words', () => {
    expect(formatKeys('⌘ ⇧ Z / ⌘ Y', true)).toBe('⌘ ⇧ Z / ⌘ Y')
    expect(formatKeys('⌘ ⇧ Z / ⌘ Y', false)).toBe('Ctrl Shift Z / Ctrl Y')
    expect(formatKeys('⌥ ]', false)).toBe('Alt ]')
  })

  it('the selection in words', () => {
    let doc: BoardDoc = emptyBoard('t')
    const a = addPicture(doc, { path: 'a.png', x: 0, y: 0, w: 10, h: 10 })
    const b = addPicture(a.doc, { path: 'b.png', x: 50, y: 0, w: 10, h: 10 })
    const n = addNote(b.doc, { text: 'x', x: 0, y: 50, w: 100, size: 12 })
    doc = n.doc
    expect(summarizeSelection(doc, []).text).toBe('Nothing selected')
    expect(summarizeSelection(doc, [a.id!]).text).toBe('1 picture selected')
    expect(summarizeSelection(doc, [a.id!, b.id!]).text).toBe('2 pictures selected')
    expect(summarizeSelection(doc, [a.id!, b.id!, n.id!]).text).toBe('3 selected: 2 pictures, 1 note')
    expect(summarizeSelection(doc, [n.id!])).toMatchObject({ total: 1, notes: 1, text: '1 note selected' })
    expect(summarizeSelection(doc, [999]).text).toBe('Nothing selected')
  })

  it('each tool says what it does', () => {
    const hint = (tool: string, extra = {}) => toolHint({ tool, cropping: null, selection: [], ...extra }, 3)
    expect(hint('note')).toBe('Click to place a note')
    expect(hint('pen')).toBe('Drag to draw')
    expect(hint('hand')).toMatch(/pan/i)
    expect(hint('sampler')).toMatch(/colour/i)
    expect(hint('crop')).toMatch(/Click the picture/)
    expect(hint('crop', { cropping: 4 })).toMatch(/Enter to finish/)
    expect(hint('select', { selection: [1] })).toMatch(/rotates/)
    expect(toolHint({ tool: 'select', cropping: null, selection: [] }, 0)).toMatch(/Drop pictures here, paste with ⌘ V/)
    expect(toolHint({ tool: 'select', cropping: null, selection: [] }, 0, false)).toMatch(/paste with Ctrl V/)
  })

  it('zoom is written with the digits that matter', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(0.125)).toBe('12.5%')
    expect(formatZoom(64)).toBe('6400%')
    expect(formatZoom(0.005)).toBe('0.5%')
    expect(formatZoom(0.0123)).toBe('1.23%')
    expect(formatZoom(NaN)).toBe('—')
    expect(formatZoom(0)).toBe('—')
  })

  it('a hex field takes #rrggbb, rrggbb and #rgb, and nothing else', () => {
    expect(parseHexInput('#FF8800')).toBe('ff8800')
    expect(parseHexInput(' ff8800 ')).toBe('ff8800')
    expect(parseHexInput('#f80')).toBe('ff8800')
    expect(parseHexInput('f80')).toBe('ff8800')
    for (const bad of ['', '#', 'ff88', 'ff88000', 'gg8800', '#ff 880', 'rgb(1,2,3)']) expect(parseHexInput(bad), bad).toBeNull()
  })

  it('a canvas pixel as hex', () => {
    expect(hexOfPixel([255, 136, 0, 255])).toBe('ff8800')
    expect(hexOfPixel([0, 0, 0])).toBe('000000')
    expect(hexOfPixel([300, -4, 7.6])).toBe('ff0008')
    expect(hexOfPixel([])).toBe('000000')
  })
})

describe('a picture’s info', () => {
  const item = (over = {}) => {
    const r = addPicture(emptyBoard('t'), { path: 'Art/Gate/rust door.JPG', x: 0, y: 0, w: 400, h: 300, ...over })
    const it = r.doc.items[0]!
    if (it.kind !== 'picture') throw new Error('not a picture')
    return it
  }

  it('says what the board shows against the picture’s own pixels', () => {
    const info = describePicture(item(), { w: 1600, h: 1200 })
    expect(info).toEqual({ name: 'rust door.JPG', path: 'Art/Gate/rust door.JPG', natural: { w: 1600, h: 1200 }, shown: { w: 400, h: 300 }, scalePercent: 25, type: 'JPG' })
    expect(infoRows(info)).toEqual([
      ['Name', 'rust door.JPG'],
      ['In the vault', 'Art/Gate/rust door.JPG'],
      ['Picture size', '1600 × 1200 px'],
      ['On the board', '400 × 300 · 25% of its pixels'],
      ['File type', 'JPG'],
    ])
  })

  it('a cropped picture shows only its shown part, and an unknown size says it is being read', () => {
    const cropped = item({ crop: { l: 0.25, t: 0, r: 0.75, b: 0.5 } })
    const info = describePicture(cropped, null)
    expect(info.shown).toEqual({ w: 200, h: 150 })
    expect(info.scalePercent).toBeNull()
    expect(infoRows(info)[2]).toEqual(['Picture size', 'reading…'])
    expect(infoRows(info)[3]![1]).toBe('200 × 150')
  })

  it('a file without an extension has no type row', () => {
    const info = describePicture(item({ path: 'Art/noext' }), null)
    expect(info.type).toBe('')
    expect(infoRows(info).some(([l]) => l === 'File type')).toBe(false)
  })
})

describe('export', () => {
  it('names the picture after the board, the day and the second, cleaned like every picture name', () => {
    const now = new Date(2026, 0, 5, 3, 4, 5)
    expect(exportFileName('Gate reference', now)).toBe('Gate reference export 2026-01-05 030405.png')
    expect(exportFileName('Ref #1 [wip] / a:b', now)).toBe('Ref -1 -wip- - a-b export 2026-01-05 030405.png')
    expect(exportFileName('   ', now)).toBe('Board export 2026-01-05 030405.png')
  })

  it('the scale follows the finest picture in it, brought down to the target side', () => {
    let doc: BoardDoc = emptyBoard('t')
    const a = addPicture(doc, { path: 'a.png', x: 0, y: 0, w: 400, h: 300 })
    doc = a.doc
    const natural = (p: string) => (p === 'a.png' ? { w: 1600, h: 1200 } : null)
    // 4x the units; the picture is 400 units, so 4x is 1600 px: under the target.
    expect(exportScale(doc, null, natural, estimateTextMetrics)).toBe(4)
    // A big board: the longer side is held to the target.
    const wide = addPicture(doc, { path: 'b.png', x: 10_000, y: 0, w: 400, h: 300 }).doc
    const s = exportScale(wide, null, natural, estimateTextMetrics)
    expect(s).toBeCloseTo(EXPORT_TARGET_SIDE / 10_400, 6)
    // Nothing of known size: twice the board's own; nothing selected that exists: 1.
    expect(exportScale(doc, null, () => null, estimateTextMetrics)).toBe(2)
    expect(exportScale(doc, [999], natural, estimateTextMetrics)).toBe(1)
    // A selection works on its own bounds.
    expect(exportScale(wide, [a.id!], natural, estimateTextMetrics)).toBe(4)
  })

  it('a picture shown larger than its pixels is not exported larger than the board shows it', () => {
    const doc = addPicture(emptyBoard('t'), { path: 'a.png', x: 0, y: 0, w: 400, h: 300 }).doc
    expect(exportScale(doc, null, () => ({ w: 100, h: 75 }), estimateTextMetrics)).toBe(1)
  })
})
