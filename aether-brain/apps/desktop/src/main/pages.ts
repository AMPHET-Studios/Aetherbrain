/**
 * The notes of a vault go to the renderer a page at a time. They used to cross in ONE reply: a vault of chats of 300 MB made that reply
 * larger than a message may be, and the main process died ("Trace/breakpoint trap") with the window and everything else. Each page is
 * at most `PAGE_BYTES` of text (a single note bigger than that is a page of its own: notes over `MAX_NOTE_BYTES` are not read at all).
 * Pure, so it is tested without Electron.
 */
export interface PageFile {
  path: string
  content: string
  mtime: number
}

export interface FilePage {
  files: PageFile[]
  /** Pass this to `more` for the next page. */
  token: number
  /** False on the last page. */
  more: boolean
}

/** Text per page, counted as two bytes a character (what a string of any script costs on the wire at most). */
export const PAGE_BYTES = 12 * 1024 * 1024
/** A note file larger than this is left on disk and not loaded (the file is untouched; it is no note, it is a dump). */
export const MAX_NOTE_BYTES = 64 * 1024 * 1024

export class FilePager {
  private files: PageFile[] = []
  private at = 0
  private token = 0

  constructor(private readonly pageBytes = PAGE_BYTES) {}

  /** A new list: the first page. Whatever an earlier list had left is dropped (its token answers nothing any more). */
  start(files: PageFile[]): FilePage {
    this.files = files
    this.at = 0
    this.token++
    return this.next()
  }

  /** The next page of the list `token` belongs to; an empty last page for a token that is not the current one. */
  more(token: number): FilePage {
    if (token !== this.token) return { files: [], token, more: false }
    return this.next()
  }

  private next(): FilePage {
    const out: PageFile[] = []
    let bytes = 0
    while (this.at < this.files.length) {
      const f = this.files[this.at]!
      const cost = f.content.length * 2 + f.path.length * 2 + 64
      if (out.length > 0 && bytes + cost > this.pageBytes) break
      out.push(f)
      bytes += cost
      this.at++
    }
    const more = this.at < this.files.length
    if (!more) this.files = []
    return { files: out, token: this.token, more }
  }
}
