/**
 * When the brain window's page dies (it ran out of memory, or the graphics driver took it down) Electron leaves
 * a dark empty window and no word. The window is reloaded, with a message saying why — unless it died a few
 * times in a row, when a reload would only die again. Pure, so it is tested without Electron.
 */

/** Crashes are counted over this long. */
export const CRASH_WINDOW_MS = 60_000
/** A window that died more often than this within `CRASH_WINDOW_MS` is left alone. */
export const CRASH_RELOADS = 2

/** `crashes` holds when each crash happened, the one just now last: reload unless that is too many lately. */
export function shouldReload(crashes: readonly number[], now: number): boolean {
  return crashes.filter((t) => now - t < CRASH_WINDOW_MS).length <= CRASH_RELOADS
}

/** What the brain window is called in the message box; the board window passes its own name. */
export const BRAIN_WINDOW_NAME = 'Aether Brain window'
/** What the reference board's floating window is called there. */
export const BOARD_WINDOW_NAME = 'board window'

/**
 * What happened, in the words of the message box (`reason` is Electron's `render-process-gone` reason, `windowName` the window that
 * died). The brain window's notes are the files on disk; the board window's board is its note as the last finished gesture left it,
 * and a note still being typed was not in it.
 */
export function crashMessage(reason: string, reloading: boolean, windowName: string = BRAIN_WINDOW_NAME): { message: string; detail: string } {
  const why =
    reason === 'oom'
      ? 'ran out of memory'
      : reason === 'launch-failed' || reason === 'integrity-failure'
        ? 'could not start'
        : reason === 'killed'
          ? 'was stopped by the system'
          : 'crashed'
  const board = windowName === BOARD_WINDOW_NAME
  return {
    message: `The ${windowName} ${why}.`,
    detail: reloading
      ? board
        ? 'It is opening again with the board as its note last had it. A note you were still typing is not in it; nothing else was lost.'
        : 'It is opening again. Your notes are the files on disk and were not touched.'
      : `It stopped several times within a minute, so it was left closed. ${board ? 'The board is in its note as the last finished gesture left it' : 'Your notes are the files on disk and were not touched'}. ${
          board ? 'Open it again from the Boards view (w); if this keeps happening' : 'Close Aether Brain and open it again; if this keeps happening'
        }, tell whoever maintains it what you did just before.`,
  }
}
