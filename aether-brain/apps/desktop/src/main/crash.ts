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
export function crashMessage(
  reason: string,
  reloading: boolean,
  windowName: string = BRAIN_WINDOW_NAME,
  extra: { memory?: string; report?: string } = {},
): { message: string; detail: string } {
  const why =
    reason === 'oom'
      ? 'ran out of memory'
      : reason === 'launch-failed' || reason === 'integrity-failure'
        ? 'could not start'
        : reason === 'killed'
          ? 'was stopped by the system'
          : 'crashed'
  const board = windowName === BOARD_WINDOW_NAME
  const after = [extra.memory, extra.report ? `A report was saved: ${extra.report}` : ''].filter(Boolean).join(' ')
  const tail = after ? `\n\n${after}` : ''
  const text = {
    message: `The ${windowName} ${why}.`,
    detail: reloading
      ? board
        ? 'It is opening again with the board as its note last had it. A note you were still typing is not in it; nothing else was lost.'
        : 'It is opening again. Your notes are the files on disk and were not touched.'
      : `It stopped several times within a minute, so it was left closed. ${board ? 'The board is in its note as the last finished gesture left it' : 'Your notes are the files on disk and were not touched'}. ${
          board ? 'Open it again from the Boards view (w); if this keeps happening' : 'Close Aether Brain and open it again; if this keeps happening'
        }, tell whoever maintains it what you did just before.`,
  }
  return { message: text.message, detail: text.detail + tail }
}

/** One look at the memory of the window's page (the renderer's working set, in MB) and the app's other processes. */
export interface MemorySample {
  /** Milliseconds (a clock, `Date.now()`). */
  t: number
  /** The window's page: working set in MB. */
  pageMB: number
  mainMB: number
  gpuMB: number
}

/** How many samples are kept (one every two seconds: the last two minutes). */
export const MEMORY_TRAIL = 60

/** The last `MEMORY_TRAIL` samples; `add` drops the oldest. Pure: the app feeds it from `app.getAppMetrics()`. */
export class MemoryTrail {
  readonly samples: MemorySample[] = []
  add(s: MemorySample): void {
    this.samples.push(s)
    if (this.samples.length > MEMORY_TRAIL) this.samples.shift()
  }
  clear(): void {
    this.samples.length = 0
  }
}

const gb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`)

/**
 * What the memory did before the page died, in one sentence: where it ended, its peak, and how it got there ("1.1 GB 20 s earlier").
 * Empty when there is nothing to say (no samples).
 */
export function describeTrail(samples: readonly MemorySample[]): string {
  const last = samples[samples.length - 1]
  if (!last) return ''
  const peak = samples.reduce((m, s) => Math.max(m, s.pageMB), 0)
  const earlier = [...samples].reverse().find((s) => last.t - s.t >= 20_000)
  const way = earlier ? `, ${gb(earlier.pageMB)} ${Math.round((last.t - earlier.t) / 1000)} s earlier` : ''
  return `The window's page was using ${gb(last.pageMB)} when it was last measured (its peak ${gb(peak)}${way}).`
}

/** The report written next to the user's settings when a page dies, so that what it was doing can be read afterwards. */
export interface CrashReport {
  time: string
  app: string
  version: string
  platform: string
  window: string
  reason: string
  exitCode: number | null
  /** The last samples, oldest first. */
  memory: MemorySample[]
  /** What the app knew of its vault (counts), if it knew. */
  vault?: Record<string, number | string>
}

export function crashReport(
  input: { reason: string; exitCode?: number | null; window: string; version: string; platform: string; now: number; vault?: Record<string, number | string> },
  samples: readonly MemorySample[],
): CrashReport {
  const report: CrashReport = {
    time: new Date(input.now).toISOString(),
    app: 'Aether Brain',
    version: input.version,
    platform: input.platform,
    window: input.window,
    reason: input.reason,
    exitCode: input.exitCode ?? null,
    memory: samples.map((s) => ({ ...s })),
  }
  if (input.vault) report.vault = input.vault
  return report
}

/** The file name of a report: sortable, no characters a file system refuses. */
export function crashReportName(now: number): string {
  return `crash-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`
}
