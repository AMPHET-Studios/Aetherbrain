/**
 * The pure half of joining reference boards to the app: which notes are boards, what a new one is called and where it lives, which
 * folder a board keeps its pictures in, what a board card shows, and how a picture is added to a board that is not open. No store, no
 * DOM, no React: the store (store.ts), the docked host (dockedHost.ts) and the boards view (BoardsView.tsx) call these, and the tests
 * call them directly. Design: docs/design/reference-board.md.
 */
import {
  BOARD_LIMITS,
  arrange,
  basenameOf,
  boardFolderName,
  boardPictures,
  addPicture,
  boardChars,
  estimateTextMetrics,
  fitView,
  folderOf,
  isBoardNote,
  isDeviceName,
  itemsBounds,
  moveItems,
  parseBoard,
  serializeBoard,
  slugifyTitle,
  type BoardDoc,
  type NoteId,
  type ParsedNote,
} from '@aether/core'

/** The folder new boards are made in, under the vault's home (`<home>Boards/<Title>.md`). */
export const BOARDS_FOLDER = 'Boards'

/** What a board made without a name is called. */
export const DEFAULT_BOARD_TITLE = 'Reference board'

/** The longer side, in board units, of a picture put on a board that is not open (its shape is the picture's own when known). */
export const ADDED_PICTURE_EDGE = 400

/** Board units between pictures put on a board that is not open, and between them and what is already there. */
const ADDED_GAP = 24

/** The error a save of a board gets when the note on disk is not the one the board was read from. */
export class BoardChangedOutsideError extends Error {
  constructor() {
    super(
      'The board was changed outside the board view (an editor, an AI or another window), so this save was not made and the note is left as it is. Reload the board to see that change.',
    )
    this.name = 'BoardChangedOutsideError'
  }
}

/* ------------------------------------------------------------- finding boards --- */

/** Whether a parsed note is a board: its frontmatter says `type: board` (what `isBoardNote` reads from the raw text, without a second parse). */
export function isBoard(note: ParsedNote): boolean {
  return note.frontmatter['type'] === 'board'
}

/** The time a note was last touched, for ordering: its `updated` day, else the file's own time, else 0. */
function touched(note: ParsedNote): number {
  const day = note.meta.updated ? Date.parse(note.meta.updated.length === 10 ? `${note.meta.updated}T00:00:00` : note.meta.updated) : NaN
  if (Number.isFinite(day)) return day
  return note.mtime ?? 0
}

/**
 * Every board of the vault, the most recently updated first (a tie by title, then path, so the order is the same on every run).
 * One pass over the notes and a look at each one's already-parsed frontmatter: no text is read again.
 */
export function listBoards(notes: ReadonlyMap<NoteId, ParsedNote>): ParsedNote[] {
  const out: ParsedNote[] = []
  for (const n of notes.values()) if (isBoard(n)) out.push(n)
  return out.sort((a, b) => touched(b) - touched(a) || a.meta.title.localeCompare(b.meta.title) || (a.meta.path < b.meta.path ? -1 : a.meta.path > b.meta.path ? 1 : 0))
}

/* ----------------------------------------------------------------- names --- */

/** A board's file name stem from what was typed: path separators and the characters a vault name cannot hold made spaces, no leading dots (the vault hides such files). */
export function boardStem(title: string): string {
  const stem = slugifyTitle(title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '))
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  // Windows takes CON, NUL, COM1 ... (also CON.x) for a device, whatever the folder: such a name gets an underscore in front.
  return stem === '' ? DEFAULT_BOARD_TITLE : isDeviceName(stem) ? `_${stem}` : stem
}

/**
 * The first name for a new board that nothing in the vault has: `Title`, then `Title 2`, `Title 3` ... `taken` says whether a
 * name (lower case) is a note's title, alias or file name already. Boards are linked and found by their title, so it is unique like a
 * file name is.
 */
export function uniqueBoardStem(title: string, taken: (lower: string) => boolean): string {
  const base = boardStem(title)
  for (let n = 1; n < 10_000; n++) {
    const stem = n === 1 ? base : `${base} ${n}`
    if (!taken(stem.toLowerCase())) return stem
  }
  return `${base} ${Date.now()}`
}

/** The title a board file's final name gives it (the name without `.md`): a note that had to be numbered keeps its title and its file name the same. */
export function boardTitleOfPath(path: string): string {
  return basenameOf(path)
}

/**
 * The folder a board keeps the pictures dropped or pasted on it in: next to the note, named like the file without `.md` and cleaned for
 * the vault (`boardFolderName`). The floating window computes the same folder from the same path, so a board's pictures stay together
 * wherever it is open.
 */
export function boardFolderOf(boardPath: string): string {
  const dir = folderOf(boardPath)
  return `${dir ? `${dir}/` : ''}${boardFolderName(basenameOf(boardPath))}`
}

/** The folder used when the vault refuses the first one (a name the user left out of the vault): `<folder> pictures`. */
export function boardFolderFallback(folder: string): string {
  return `${folder} pictures`
}

/** Whether two paths name the same board: equal, or equal in any letter case (Windows and macOS file names do not tell cases apart). */
export function samePath(a: string, b: string, caseSensitive = false): boolean {
  return a === b || (!caseSensitive && a.toLowerCase() === b.toLowerCase())
}

/* ------------------------------------------------------- what a card shows --- */

export interface BoardSummary {
  /** Distinct pictures on the board. */
  pictures: number
  /** Text notes. */
  notes: number
  /** Drawn marks (pen, lines, rectangles, ellipses). */
  marks: number
  /** The first few distinct pictures (vault paths) for the card's collage. */
  first: string[]
}

/** Pictures in a card's collage. */
export const COLLAGE_PICTURES = 4

const SUMMARIES = new Map<string, { raw: string; summary: BoardSummary }>()
/** Summaries kept (a card is parsed once, not on every redraw of the list). */
const SUMMARY_KEEP = 200

/** What a board's card shows, from the note's text; parsed once per version of the text and kept (bounded). */
export function summarizeBoard(path: string, raw: string): BoardSummary {
  const hit = SUMMARIES.get(path)
  if (hit && hit.raw === raw) return hit.summary
  const { doc } = parseBoard(raw)
  const all = boardPictures(doc)
  let notes = 0
  let marks = 0
  for (const it of doc.items) {
    if (it.kind === 'note') notes++
    else if (it.kind !== 'picture') marks++
  }
  const summary: BoardSummary = { pictures: all.length, notes, marks, first: all.slice(0, COLLAGE_PICTURES) }
  SUMMARIES.delete(path)
  SUMMARIES.set(path, { raw, summary })
  for (const old of SUMMARIES.keys()) {
    if (SUMMARIES.size <= SUMMARY_KEEP) break
    SUMMARIES.delete(old)
  }
  return summary
}

/** Empties the kept summaries (a test, or another vault). */
export function forgetSummaries(): void {
  SUMMARIES.clear()
}

/* --------------------------------------------- pictures onto a closed board --- */

/** A picture to add: its vault path and the size it is shown at, in board units. */
export interface PictureToAdd {
  path: string
  w: number
  h: number
}

/** The size a picture of this shape (width over height) is shown at, longer side `ADDED_PICTURE_EDGE`; 400 by 300 when its shape is not known. */
export function fitPictureSize(aspect: number | null): { w: number; h: number } {
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return { w: ADDED_PICTURE_EDGE, h: (ADDED_PICTURE_EDGE * 3) / 4 }
  const a = Math.min(Math.max(aspect, 1 / 20), 20)
  return a >= 1 ? { w: ADDED_PICTURE_EDGE, h: ADDED_PICTURE_EDGE / a } : { w: ADDED_PICTURE_EDGE * a, h: ADDED_PICTURE_EDGE }
}

/** What decoding a small preview gives: its pixel size, and a way to let go of it. */
export interface Decoded {
  width: number
  height: number
  close?(): void
}

/**
 * A picture's shape (width over height), read from a small preview of it, or null when there is no preview or this page cannot decode
 * one (a node test, a broken file). The preview is a few KB, so a whole batch costs little; the real size arrives when the board is
 * opened and the picture is loaded (the controller corrects the shape then, keeping the width).
 */
export async function pictureAspect(
  preview: (path: string, px: number) => Promise<Blob | null>,
  path: string,
  decode: ((blob: Blob) => Promise<Decoded>) | undefined = typeof createImageBitmap === 'function' ? (b) => createImageBitmap(b) : undefined,
): Promise<number | null> {
  if (!decode) return null
  try {
    const blob = await preview(path, 128)
    if (!blob) return null
    const bitmap = await decode(blob)
    const { width, height } = bitmap
    bitmap.close?.()
    return width > 0 && height > 0 ? width / height : null
  } catch {
    return null
  }
}

export interface AddedToBoard {
  /** The board note's new text (the very same string when nothing was added). */
  text: string
  added: number
  /** The pictures added, in the order given. */
  paths: string[]
  /** Pictures that were already on the board (not added twice). */
  skipped: number
  /** Pictures left out because the board holds BOARD_LIMITS.items already. */
  full: number
  /** Pictures left out because the board would pass its size budget (BOARD_LIMITS.noteTotal characters of items). */
  over: number
}

/** The size budget as the messages say it ("it holds at most about 500,000 characters of items"); the controller's wording. */
export const BOARD_BUDGET_TEXT = `it holds at most about ${BOARD_LIMITS.noteTotal.toLocaleString('en-US')} characters of items`

/**
 * Puts pictures on a board that is not open: written into the note's text, parsed and serialised like every board save (so
 * everything the board section does not own stays byte for byte, and hand-written lines survive). A picture the board already shows is
 * skipped. The new ones are packed into one tidy block (the 'optimal' arrangement) to the right of what is on the board, level with
 * its top; on an empty board the block is centred on the origin and the view is set to show it whole. Throws when `raw` is not a board.
 * The board never grows past its size budget here (`BOARD_LIMITS.noteTotal`, core's `boardChars`, the controller's rule): as many
 * pictures are added as fit, the rest are counted in `over`; a board already over it takes none (it can be thinned, never grown).
 */
export function addPicturesToBoardText(raw: string, items: readonly PictureToAdd[], now: Date = new Date()): AddedToBoard {
  if (!isBoardNote(raw)) throw new Error('This note is not a board (its frontmatter has no type: board)')
  const { doc } = parseBoard(raw)
  const have = new Set(boardPictures(doc))
  /** The pictures that are new and fit the item limit, in the order given. */
  const take: PictureToAdd[] = []
  let skipped = 0
  let full = 0
  let room = doc
  for (const it of items) {
    if (have.has(it.path)) {
      skipped++
      continue
    }
    const res = addPicture(room, { path: it.path, w: it.w, h: it.h, x: 0, y: 0 })
    if (res.id === null) {
      full++
      continue
    }
    room = res.doc
    take.push(it)
    have.add(it.path)
  }

  /** The board with the first `count` of them on it: packed to the right of what is there (or centred, with the view fitted, on an empty board). */
  const place = (count: number): BoardDoc => {
    let next = doc
    const ids: number[] = []
    for (const it of take.slice(0, count)) {
      const res = addPicture(next, { path: it.path, w: it.w, h: it.h, x: 0, y: 0 })
      if (res.id === null) break
      next = res.doc
      ids.push(res.id)
    }
    if (ids.length === 0) return doc
    next = arrange(next, ids, 'optimal', { gap: ADDED_GAP })
    const mine = next.items.filter((i) => ids.includes(i.id))
    const block = itemsBounds(mine, estimateTextMetrics)
    const before = doc.items.length > 0 ? itemsBounds(doc.items, estimateTextMetrics) : null
    if (block) {
      // Right of what is there, level with its top; on an empty board, the block's middle on the origin.
      const dx = before ? before.x + before.w + ADDED_GAP * 4 - block.x : -(block.x + block.w / 2)
      const dy = before ? before.y - block.y : -(block.y + block.h / 2)
      next = moveItems(next, ids, dx, dy)
    }
    if (doc.items.length === 0) {
      const all = itemsBounds(next.items, estimateTextMetrics)
      next = { ...next, view: fitView(all, { w: 1200, h: 760 }, 60) }
    }
    return next
  }

  // The size is judged on the board as it will be written (the arrangement gives every picture its coordinates): the most pictures
  // whose board fits the budget, or is no bigger than the board is now. More pictures never make a smaller board, so a halving finds it.
  const start = boardChars(doc)
  const fits = (n: number): boolean => {
    const after = boardChars(place(n))
    return after <= BOARD_LIMITS.noteTotal || after <= start
  }
  let count = take.length
  if (count > 0 && !fits(count)) {
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(mid)) lo = mid
      else hi = mid - 1
    }
    count = lo
  }
  const over = take.length - count
  if (count === 0) return { text: raw, added: 0, paths: [], skipped, full, over }
  return { text: serializeBoard(place(count), raw, now), added: count, paths: take.slice(0, count).map((it) => it.path), skipped, full, over }
}

/** The most pictures one call puts on a board (a whole folder at once would be a board nobody can read; the board holds BOARD_LIMITS.items). */
export const MAX_ADDED_AT_ONCE = Math.min(200, BOARD_LIMITS.items)

/* ------------------------------------------------ previews for the board cards --- */

export interface PreviewUrlOptions {
  /** Pictures kept ready that nothing shows (default 120): the cards scrolled past, so scrolling back is instant. */
  keep?: number
  /** Previews asked for at once (default 4). */
  parallel?: number
  /** Longer side of a preview, px (default 256). */
  px?: number
  create?(blob: Blob): string
  revoke?(url: string): void
}

/**
 * Object URLs of small previews for the cards of the boards list, bounded three ways: only the previews something shows are held
 * (`acquire` / `release` count the users), at most `keep` idle ones are kept for a quick scroll back (the oldest are revoked), and at
 * most `parallel` are fetched at a time. A path asked for by no one any more when its turn comes is not fetched at all. Not tied to
 * React: a card acquires when it comes into view and releases when it leaves.
 */
export class PreviewUrls {
  private readonly urls = new Map<string, string>()
  private readonly users = new Map<string, number>()
  private readonly loading = new Map<string, Promise<string | null>>()
  private waiting: (() => void)[] = []
  private running = 0
  /** Bumped by `dispose`: a preview still on its way when it moved on is let go of, not kept. */
  private generation = 0
  private readonly keep: number
  private readonly parallel: number
  private readonly px: number
  private readonly create: (blob: Blob) => string
  private readonly revoke: (url: string) => void

  constructor(
    private readonly load: (path: string, px: number) => Promise<Blob | null>,
    opts: PreviewUrlOptions = {},
  ) {
    this.keep = opts.keep ?? 120
    this.parallel = opts.parallel ?? 4
    this.px = opts.px ?? 256
    this.create = opts.create ?? ((b) => URL.createObjectURL(b))
    this.revoke = opts.revoke ?? ((u) => URL.revokeObjectURL(u))
  }

  /** The preview's URL (null when there is none), held until `release`. Every call needs its own `release`. */
  acquire(path: string): Promise<string | null> {
    this.users.set(path, (this.users.get(path) ?? 0) + 1)
    const have = this.urls.get(path)
    if (have !== undefined) {
      // Newest last: the idle ones are let go oldest first.
      this.urls.delete(path)
      this.urls.set(path, have)
      return Promise.resolve(have)
    }
    let pending = this.loading.get(path)
    if (!pending) {
      pending = this.fetch(path)
      this.loading.set(path, pending)
    }
    return pending
  }

  release(path: string): void {
    const n = (this.users.get(path) ?? 0) - 1
    if (n > 0) this.users.set(path, n)
    else this.users.delete(path)
    this.trim()
  }

  /** Previews held (shown or idle). */
  get size(): number {
    return this.urls.size
  }

  /** Lets go of every URL (the list closed, another vault). The object can be used again. */
  dispose(): void {
    this.generation++
    for (const url of this.urls.values()) this.revoke(url)
    this.urls.clear()
    this.users.clear()
    this.loading.clear()
    this.running = 0
    // Whoever still waits for a turn is answered (nothing): its generation is gone.
    const waiting = this.waiting
    this.waiting = []
    for (const run of waiting) run()
  }

  private fetch(path: string): Promise<string | null> {
    const generation = this.generation
    return new Promise((resolve) => {
      const run = (): void => {
        if (generation !== this.generation) return resolve(null)
        // Nobody wants it any more (scrolled past while it waited): no fetch.
        if ((this.users.get(path) ?? 0) === 0) {
          this.loading.delete(path)
          resolve(null)
          return this.next()
        }
        this.running++
        this.load(path, this.px)
          .then(
            (blob) => (blob ? this.create(blob) : null),
            () => null,
          )
          .then((url) => {
            if (generation !== this.generation) {
              if (url) this.revoke(url)
              return resolve(null)
            }
            this.running--
            this.loading.delete(path)
            if (url) {
              this.urls.set(path, url)
              this.trim()
            }
            resolve(url)
            this.next()
          })
      }
      if (this.running < this.parallel) run()
      else this.waiting.push(run)
    })
  }

  private next(): void {
    const run = this.waiting.shift()
    if (run) run()
  }

  /** Revokes the oldest idle previews beyond `keep`. */
  private trim(): void {
    let idle = 0
    for (const path of this.urls.keys()) if (!this.users.has(path)) idle++
    if (idle <= this.keep) return
    for (const [path, url] of this.urls) {
      if (idle <= this.keep) break
      if (this.users.has(path)) continue
      this.urls.delete(path)
      this.revoke(url)
      idle--
    }
  }
}
