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

/** What happened, in the words of the message box (`reason` is Electron's `render-process-gone` reason). */
export function crashMessage(reason: string, reloading: boolean): { message: string; detail: string } {
  const why =
    reason === 'oom'
      ? 'ran out of memory'
      : reason === 'launch-failed' || reason === 'integrity-failure'
        ? 'could not start'
        : reason === 'killed'
          ? 'was stopped by the system'
          : 'crashed'
  return {
    message: `The Aether Brain window ${why}.`,
    detail: reloading
      ? 'It is opening again. Your notes are the files on disk and were not touched.'
      : 'It stopped again right after opening, so it was left closed. Your notes are the files on disk and were not touched. Close Aether Brain and open it again; if this keeps happening, tell whoever maintains it what you did just before.',
  }
}
