/**
 * The reference board's host for the docked view in the brain window: `BoardHost` (api.ts) over the store. The note is read and written
 * through `store.readBoard` / `store.saveBoard` (the exclusive per-note queue, the file as it is on disk), pictures through the store's
 * previews, `readPicture` and `importBoardPictures`, and the floating window's controls through the registry the desktop app fills
 * (`getBoardWindowControl`, active.ts), so on the web, where there is none, `window` is absent and the board has no pop-out.
 *
 * Saving. A save carries the text it was made from (`expectedBase`, else the text this host last read or wrote): when the file holds
 * anything else (and not the very text to be written) it is refused with `BoardChangedOutsideError` ("changed outside") and the
 * external-change callbacks are told, so the view reloads or warns; the host then refuses every save until `load()` reads the note
 * again, so a view that keeps trying cannot overwrite a newer edit, and every refusal asks for that reload once more (a reload that
 * failed because the note was edited into something that is no board can succeed once the note is put right). A refusal of a save
 * that began before the last reload ended is about a text the view has already replaced: it asks for the reload but does not set the
 * flag again (it would block the save the view makes from the new text). The store's own report of
 * a write (it applies every write as an outside change) is told apart from somebody else's by the texts this host read or wrote: it
 * keeps the last few, like the floating window's host.
 *
 * No React, no DOM here: a store, timers and Blobs. Design: docs/design/reference-board.md.
 */
import { basenameOf, idFromPath, isImagePath, parseBoard, type VaultAsset } from '@aether/core'
import { copyText } from '../components/pictures'
import { useAether } from '../store'
import { getBoardWindowControl, type BoardWindowControl } from './active'
import { BOARD_GONE, type BoardHost, type BoardWindowHost } from './api'
import { BoardChangedOutsideError } from './boardRegistry'

export { BoardChangedOutsideError } from './boardRegistry'

/** How many of its own texts the host remembers to tell the store's report of a save from somebody else's edit. */
export const ECHO_TEXTS = 4

/** The host, and the way to let go of its subscriptions. */
export type DockedBoardHost = BoardHost & { dispose(): void }

export function createDockedBoardHost(path: string): DockedBoardHost {
  const store = () => useAether.getState()
  const id = idFromPath(path)
  const fileTitle = basenameOf(path)
  let title = store().notes.get(id)?.meta.title ?? fileTitle

  /* ---- the note ---- */

  /** The note as this host last read or wrote it. */
  let lastKnown: string | null = null
  /** A save found the note changed: refused until the note is read again. */
  let stale = false
  /** How many reads have ended: a refusal of a save that was called before the latest one is about a text that has been replaced. */
  let loads = 0
  /** The last few texts read or written, newest last. */
  const echoes: string[] = []
  const remember = (text: string): void => {
    const at = echoes.indexOf(text)
    if (at >= 0) echoes.splice(at, 1)
    echoes.push(text)
    if (echoes.length > ECHO_TEXTS) echoes.shift()
  }
  const externalSubs = new Set<() => void>()
  const changedOutside = (): void => {
    for (const cb of [...externalSubs]) cb()
  }
  /** Saves run one after the other. */
  let writing: Promise<unknown> = Promise.resolve()

  async function write(raw: string, expectedBase: string | undefined, loadsAtCall: number): Promise<void> {
    if (stale) {
      // Still not read again: ask again (the view may have given up on a reload that could not read the note).
      changedOutside()
      throw new BoardChangedOutsideError()
    }
    // Before the write: the store reports it to its subscribers (this host's among them) while it is still under way.
    remember(raw)
    try {
      await store().saveBoard(path, raw, expectedBase ?? lastKnown)
    } catch (err) {
      if (err instanceof BoardChangedOutsideError) {
        if (loads === loadsAtCall) stale = true
        changedOutside()
      }
      throw err
    }
    lastKnown = raw
  }

  /* ---- the store's report of the note ---- */

  /** What the store held of the note when the host last looked (a text; null: not looked yet; undefined: no such note). */
  let seen: string | undefined | null = null
  /** Tells the callbacks when the note in the store is a text this host did not read or write. */
  const check = (): void => {
    const raw = store().notes.get(id)?.raw
    if (raw === seen) return
    seen = raw
    // Gone (deleted, moved): the view finds out when it tries to read or save. Else only a text this host did not write is news.
    if (raw === undefined) return changedOutside()
    // Before the first load there is nothing to differ from; the load reads whatever is there.
    if (lastKnown === null || raw === lastKnown || echoes.includes(raw)) return
    changedOutside()
  }
  /** Listening to the store only while somebody listens to the host (a view that mounts, unmounts and mounts again starts over cleanly). */
  let offNotes: (() => void) | null = null
  const listen = (): void => {
    if (offNotes) return
    seen = null
    offNotes = useAether.subscribe(check)
    check()
  }
  const unlisten = (): void => {
    offNotes?.()
    offNotes = null
  }

  /* ---- the window ---- */

  /** What the toolbar last asked for, until the desktop app answers (so a click is seen at once). */
  const asked: { alwaysOnTop?: boolean; opacity?: number } = {}
  let windowHost: { control: BoardWindowControl; host: BoardWindowHost } | null = null
  let offControl: (() => void) | null = null
  const windowOf = (control: BoardWindowControl): BoardWindowHost => {
    if (windowHost?.control === control) return windowHost.host
    offControl?.()
    // The desktop app's answer replaces what was asked.
    offControl = control.subscribe(() => {
      delete asked.alwaysOnTop
      delete asked.opacity
    })
    const host: BoardWindowHost = {
      floating: false,
      get alwaysOnTop() {
        return asked.alwaysOnTop ?? control.status().alwaysOnTop
      },
      get opacity() {
        return asked.opacity ?? control.status().opacity
      },
      get supportsOpacity() {
        return control.status().supportsOpacity
      },
      popOut: () => void control.popOut(path),
      // Docked already.
      dock: () => undefined,
      setAlwaysOnTop: (on) => {
        asked.alwaysOnTop = on
        void control.setAlwaysOnTop(on)
      },
      setOpacity: (opacity) => {
        if (!Number.isFinite(opacity)) return
        asked.opacity = Math.min(1, Math.max(0.2, opacity))
        void control.setOpacity(asked.opacity)
      },
    }
    windowHost = { control, host }
    return host
  }

  const reveal = store().adapter?.reveal ? { reveal: (p: string) => void store().reveal(p) } : {}

  return {
    path,
    get title() {
      return title
    },
    // The camera and the copy of an unsaved board are kept per vault: a board of the same path in another vault is another board.
    get stateKey() {
      return `${store().adapter?.location ?? ''}\n${path}`
    },
    async load() {
      // A board that was open and whose note has gone: the Boards view has said so, and the store would say it again (a toast of its
      // own). The session is told by the error's name and keeps quiet; its saves say what they must.
      if (lastKnown !== null && !store().notes.has(id)) {
        const gone = new Error('The note of this board is gone from the vault')
        gone.name = BOARD_GONE
        throw gone
      }
      const text = await store().readBoard(path)
      if (text === null) throw new Error('This note is not a board, is gone, or could not be read')
      lastKnown = text
      stale = false
      loads++
      remember(text)
      title = parseBoard(text).doc.title.trim() || store().notes.get(id)?.meta.title || fileTitle
      return text
    },
    save(raw, expectedBase) {
      const loadsAtCall = loads
      const run = writing.then(() => write(raw, expectedBase, loadsAtCall))
      writing = run.catch(() => undefined)
      return run
    },
    onExternalChange(cb) {
      externalSubs.add(cb)
      listen()
      return () => {
        externalSubs.delete(cb)
        if (externalSubs.size === 0) unlisten()
      }
    },
    pictures: {
      preview: (p, px) => store().preview(p, px),
      original: (p) => store().readPicture(p),
      add: (files) => store().importBoardPictures(path, files),
      list: async () => {
        const out: VaultAsset[] = []
        for (const a of store().assets.values()) if (isImagePath(a.path)) out.push(a)
        return out
      },
      exists: (p) => store().assets.has(p),
      open: (p) => void store().openImage(p),
      ...reveal,
      showInBrain: (p) => store().showPicture(p),
      onChange: (cb) => useAether.subscribe((s, prev) => s.assets !== prev.assets && cb()),
    },
    toast: (text, tone = 'info', action) => store().toast(text, tone, action),
    copyText: (text) => copyText(text),
    get window() {
      const control = getBoardWindowControl()
      return control?.available ? windowOf(control) : undefined
    },
    dispose() {
      unlisten()
      offControl?.()
      offControl = null
      windowHost = null
      externalSubs.clear()
    },
  }
}
