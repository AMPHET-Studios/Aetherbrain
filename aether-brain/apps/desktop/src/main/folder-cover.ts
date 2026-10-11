/**
 * Which picture stands for a folder: what the Unreal viewer shows as the folder's extra-large thumbnail when the brain
 * window did not name one (a folder whose picture moons are not drawn). Worked out from the scan's list of pictures,
 * found by name only: for each folder the picture that sorts last by name among those directly inside it (names are
 * often dates or numbers, so that is usually the newest), a still picture before a video. Built once per scan.
 *
 * Pure Node (no electron import), unit-tested.
 */
import { isVideoName, type ScanResult } from './fsvault.js'

interface Pick {
  path: string
  video: boolean
  /** Lower-cased file name, for comparing. */
  key: string
}

export class FolderCovers {
  private index: Map<string, Pick> | null = null
  private builtFor: ScanResult | null = null

  /** The vault path of the picture for `folder` (a vault path, '' for the root), or null when it has none. */
  coverFor(scan: ScanResult, folder: string): string | null {
    if (this.builtFor !== scan || !this.index) {
      this.index = FolderCovers.build(scan)
      this.builtFor = scan
    }
    return this.index.get(normal(folder))?.path ?? null
  }

  /** How many folders have a cover (for tests and the log). */
  size(scan: ScanResult): number {
    this.coverFor(scan, '')
    return this.index?.size ?? 0
  }

  private static build(scan: ScanResult): Map<string, Pick> {
    const index = new Map<string, Pick>()
    for (const a of scan.assets) {
      const p = a.path.replace(/\\/g, '/')
      const slash = p.lastIndexOf('/')
      const dir = slash < 0 ? '' : p.slice(0, slash)
      const name = slash < 0 ? p : p.slice(slash + 1)
      const video = isVideoName(name)
      const key = name.toLowerCase()
      const old = index.get(dir)
      // A still beats a video; among the same sort, the later name.
      if (!old || (old.video && !video) || (old.video === video && key > old.key)) index.set(dir, { path: a.path, video, key })
    }
    return index
  }
}

function normal(folder: string): string {
  return folder.replace(/\\/g, '/').replace(/\/+$/, '')
}
