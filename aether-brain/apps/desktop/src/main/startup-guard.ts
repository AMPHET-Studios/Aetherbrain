/**
 * A window that dies while a vault is opening must not become a crash loop. The app reopens the remembered folders at
 * launch, and the window reloads itself after a crash (crash.ts): with a vault too big for the page, that is open, die,
 * reload, open, die, a box saying "ran out of memory" again and again, and no way to choose other folders.
 *
 * The guard writes one small file (`startup.json` next to the settings) when a vault starts to open and removes it when
 * the page has been alive with the vault loaded for a while (`settle`, called from the page). A page that comes up and
 * finds the file still there knows the last open did not get through: it does not open the folders by itself, it says so
 * and lets the user pick (the same folders again, without pictures and videos, or other folders). A clean quit clears
 * the file unless the page had died, so closing the app after a crash does not hide it.
 *
 * Pure Node (no electron import); every file failure is swallowed: the guard never keeps the app from opening.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** An open that has not been settled yet. */
export interface OpenAttempt {
  /** The folders being opened, as typed (absolute paths). */
  roots: string[]
  /** ISO time the open began. */
  at: string
  /** The brain window's page died while the attempt was pending. */
  died: boolean
}

/** Most folders remembered in an attempt (a whole set of roots is a handful). */
const MAX_ROOTS = 64

function read(file: string): OpenAttempt | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    const roots = o['roots']
    if (!Array.isArray(roots) || !roots.length || !roots.every((r) => typeof r === 'string' && r !== '')) return null
    if (typeof o['at'] !== 'string') return null
    return { roots: (roots as string[]).slice(0, MAX_ROOTS), at: o['at'], died: o['died'] === true }
  } catch {
    return null
  }
}

export class StartupGuard {
  private pending: OpenAttempt | null

  /** Reads what the last run left behind (nothing, after a normal run). */
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.pending = read(file)
  }

  private save(): void {
    try {
      if (!this.pending) {
        rmSync(this.file, { force: true })
        return
      }
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.pending))
    } catch {
      /* the guard is a help: a disk that will not take a few bytes changes nothing else */
    }
  }

  /** A vault starts to open (any set of folders, from launch, the picker or the folders panel). */
  begin(roots: readonly string[]): void {
    const list = roots.filter((r) => r !== '').slice(0, MAX_ROOTS)
    if (!list.length) return
    this.pending = { roots: list, at: new Date(this.now()).toISOString(), died: false }
    this.save()
  }

  /** The page has had the vault loaded and stayed alive: the open got through. */
  settle(): void {
    if (!this.pending) return
    this.pending = null
    this.save()
  }

  /** The brain window's page died (out of memory, crashed, stopped by the system) while an open was pending. */
  died(): void {
    if (!this.pending || this.pending.died) return
    this.pending = { ...this.pending, died: true }
    this.save()
  }

  /** The app is quitting by itself: an open cut short by the user is forgotten, one cut short by a dead page is not. */
  cleanExit(): void {
    if (this.pending && !this.pending.died) this.settle()
  }

  /** The open that did not get through, or null. A copy. */
  interrupted(): OpenAttempt | null {
    return this.pending ? { ...this.pending, roots: [...this.pending.roots] } : null
  }
}

/** What the newest crash report in `dir` says (written at or after `since`), for the notice after a crash. */
export interface LatestCrash {
  /** The report's file. */
  file: string
  reason: string
  /** The report's memory samples (see crash.ts `MemorySample`), as read. */
  memory: unknown[]
  /** `vault` counts the report holds, if any. */
  vault: Record<string, number | string> | null
}

/**
 * The newest report whose time is not before `since` (an ISO time), or null. Report names sort by time (`crashReportName`).
 * Reads one small file; a folder or file that cannot be read is no report.
 */
export function latestCrash(dir: string, since: string): LatestCrash | null {
  try {
    const names = readdirSync(dir)
      .filter((n) => /^crash-.*\.json$/.test(n))
      .sort()
    for (let i = names.length - 1; i >= 0 && i >= names.length - 5; i--) {
      const file = path.join(dir, names[i]!)
      const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      const time = typeof o['time'] === 'string' ? o['time'] : ''
      if (!time || time < since) return null
      const vault = o['vault']
      return {
        file,
        reason: typeof o['reason'] === 'string' ? o['reason'] : '',
        memory: Array.isArray(o['memory']) ? o['memory'] : [],
        vault: vault && typeof vault === 'object' ? (vault as Record<string, number | string>) : null,
      }
    }
  } catch {
    /* no folder, no report */
  }
  return null
}
