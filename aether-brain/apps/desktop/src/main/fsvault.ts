/**
 * The vault on disk: one or more root folders seen as a single tree of vault
 * paths (posix, relative). Pure Node, no Electron, so the MCP server bundles
 * the same code and enforces the same jail.
 *
 * Single root: vault paths are relative to it (`Projects/x.md`).
 * Several roots: the first segment is the root's mount (`D/Projects/x.md`).
 *
 * Every operation is path-jailed to its root and refuses paths that the scan
 * would skip (hidden, system and heavy folders, user excludes), both by name
 * and as resolved on disk (symlinks, junctions, 8.3 short names), so nothing
 * outside the visible vault can be read or written through this class.
 */
import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'

/**
 * Lowercased folder names never scanned, watched or written into: build
 * output, dependency trees, engine caches, and OS system folders. Hidden
 * (`.` prefixed) and `$` prefixed names are skipped by rule, not by this list.
 */
export const HEAVY_DIRS: Set<string> = new Set([
  'node_modules', '__macosx', '__pycache__', 'venv', 'env', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  // Unreal / Unity / game projects
  'intermediate', 'saved', 'deriveddatacache', 'binaries', 'library', 'temp', 'logs',
  // misc caches and vendored code
  'cache', 'caches', 'tmp', 'coverage', 'bower_components', 'vendor', 'third_party', 'thirdparty', 'site-packages',
  // whole-drive roots: OS, installers, app data, game libraries
  'steamapps', 'windowsapps', 'appdata', 'system volume information', 'windows', 'program files',
  'program files (x86)', 'programdata', 'recovery', 'perflogs', 'msocache', 'config.msi',
])

/** Repo boilerplate that is never a note (exact, case-sensitive basenames). */
const BOILERPLATE = new Set([
  'LICENSE.md', 'LICENCE.md', 'CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  'SECURITY.md', 'AUTHORS.md', 'NOTICE.md', 'PULL_REQUEST_TEMPLATE.md', 'ISSUE_TEMPLATE.md',
])

/** Suffix of the temp sibling used by atomic writes; always ignored. */
const TMP_SUFFIX = '.aether-tmp'

/** True for a file name the vault treats as a note: `.md` (any case) and not repo boilerplate. */
export function isNoteName(name: string): boolean {
  return /\.md$/i.test(name) && !BOILERPLATE.has(name)
}

export interface MountedRoot {
  /** Absolute path on disk. */
  abs: string
  /** First vault path segment for this root ('' in a single-root vault). */
  mount: string
  /** Human label: `D:\` for a drive root, else the folder name. */
  label: string
}

export interface ScanResult {
  files: { path: string; abs: string }[]
  /** Every visited folder as a vault path (single root: the root itself excluded; several roots: mounts included). */
  folders: string[]
  /** True when the scan stopped at `maxDirs`. */
  truncated: boolean
  /** Folders read. */
  dirs: number
}

export interface ScanProgress {
  dirs: number
  found: number
}

/** `D:\`, `d:/` or `D:` → `D`; anything else → null. */
function driveLetter(abs: string): string | null {
  const m = /^([A-Za-z]):[\\/]?$/.exec(abs)
  return m ? m[1]!.toUpperCase() : null
}

/** Last non-empty segment of an absolute path, whatever its separators. */
function lastSegment(abs: string): string {
  return abs.split(/[\\/]+/).filter(Boolean).pop() ?? ''
}

/** Comparable form of an absolute path: Windows paths are case-insensitive (`D:\` and `d:\` are one root). */
function pathKey(abs: string): string {
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** Vault path segments: backslashes normalized, leading/duplicate slashes and `.` segments dropped. */
function segmentsOf(vaultPath: string): string[] {
  return vaultPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
}

/** True when `path.relative(root, x)` points outside the root. */
function outside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/** A unique temp sibling of `full` (ends in TMP_SUFFIX, so scans and watchers skip it). */
function tempPath(full: string): string {
  return `${full}.${Math.random().toString(36).slice(2, 10)}${TMP_SUFFIX}`
}

/**
 * `p` with symlinks, Windows junctions and 8.3 short names resolved: the real
 * path of its deepest existing ancestor with the missing rest appended.
 */
async function realish(p: string): Promise<string> {
  const rest: string[] = []
  for (let cur = p; ; ) {
    try {
      return path.join(await fs.realpath(cur), ...rest)
    } catch (err) {
      const code = errCode(err)
      const parent = path.dirname(cur)
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === cur) throw err
      rest.unshift(path.basename(cur))
      cur = parent
    }
  }
}

/** fs.rename, retried briefly when Windows reports the target busy (indexers, antivirus). */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const code = errCode(err)
      const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (attempt >= 4 || !busy || process.platform !== 'win32') throw err
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
    }
  }
}

/**
 * rename() across devices (a multi-root vault spanning `D:\` and `F:\`):
 * copy to a temp sibling, move it into place, then delete the source.
 */
async function moveAcross(from: string, to: string): Promise<void> {
  const tmp = tempPath(to)
  try {
    await fs.cp(from, tmp, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
    await renameRetry(tmp, to)
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  await fs.rm(from, { recursive: true, force: true })
}

export class FsVault {
  readonly roots: MountedRoot[]
  readonly multi: boolean
  lastScan: ScanResult | null = null
  private readonly maxDirs: number
  private excludeNames: string[] = []
  private excludeSet = new Set<string>()

  constructor(roots: string[], opts: { exclude?: string[]; maxDirs?: number } = {}) {
    const unique = new Map<string, string>()
    for (const r of roots.map((x) => path.resolve(x))) if (!unique.has(pathKey(r))) unique.set(pathKey(r), r)
    if (!unique.size) throw new Error('A vault needs at least one root folder')
    this.roots = FsVault.mountNames([...unique.values()])
    this.multi = this.roots.length > 1
    this.maxDirs = opts.maxDirs ?? 250_000
    this.exclude = opts.exclude ?? []
  }

  /** Extra folder names skipped everywhere (case-insensitive). Assign a new array to change it. */
  get exclude(): string[] {
    return this.excludeNames
  }
  set exclude(names: string[]) {
    this.excludeNames = [...names]
    this.excludeSet = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))
  }

  /**
   * Mount and label per root: a drive root → its letter (`D`), `/` → `root`,
   * else the folder name without leading `.`/`$` (a mount must never look
   * hidden: `~/.notes` → `notes`); collisions (case-insensitive) get ` 2`, ` 3`, ….
   * A single root gets mount '' (its paths are relative to it).
   */
  static mountNames(absRoots: string[]): MountedRoot[] {
    const used = new Set<string>()
    return absRoots.map((abs) => {
      const drive = driveLetter(abs)
      const name = path.basename(abs) || lastSegment(abs)
      const base = drive ?? (name.replace(/^[.$]+/, '') || 'root')
      const label = drive ? `${drive}:\\` : name || abs
      let mount = base
      for (let n = 2; used.has(mount.toLowerCase()); n++) mount = `${base} ${n}`
      used.add(mount.toLowerCase())
      return { abs, mount: absRoots.length > 1 ? mount : '', label }
    })
  }

  /** The root a vault path lives in and the segments inside it. Throws for '' or an unknown mount in multi-root. */
  private locate(vaultPath: string): { root: MountedRoot; inner: string[] } {
    const segs = segmentsOf(vaultPath)
    if (!this.multi) return { root: this.roots[0]!, inner: segs }
    const head = segs[0]
    if (head === undefined) throw new Error('A multi-root vault path must start with a root folder')
    const lower = head.toLowerCase()
    const root = this.roots.find((r) => r.mount === head) ?? this.roots.find((r) => r.mount.toLowerCase() === lower)
    if (!root) throw new Error(`Unknown vault root: ${head}`)
    return { root, inner: segs.slice(1) }
  }

  /** vault path → absolute path; throws on escape, unknown mount, or '' in multi-root. */
  abs(vaultPath: string): string {
    const { root, inner } = this.locate(vaultPath)
    const full = path.resolve(root.abs, ...inner)
    if (outside(path.relative(root.abs, full))) throw new Error(`Path escapes vault: ${vaultPath}`)
    return full
  }

  /** absolute path → vault path, or null when outside every root (the deepest matching root wins). */
  toVault(abs: string): string | null {
    const full = path.resolve(abs)
    let best: { root: MountedRoot; rel: string } | null = null
    for (const root of this.roots) {
      const rel = path.relative(root.abs, full)
      if (outside(rel)) continue
      if (!best || root.abs.length > best.root.abs.length) best = { root, rel }
    }
    if (!best) return null
    const inner = best.rel.split(path.sep).filter(Boolean).join('/')
    if (!this.multi) return inner
    return inner ? `${best.root.mount}/${inner}` : best.root.mount
  }

  /** True for one path segment (folder or file name) the vault never looks into. */
  private ignoredName(raw: string): boolean {
    // Windows drops trailing dots and spaces (`AppData.` opens AppData), so compare without them.
    const name = raw.replace(/[. ]+$/, '')
    if (raw.startsWith('.') || name.startsWith('$') || name.endsWith(TMP_SUFFIX)) return true
    const lower = name.toLowerCase()
    return HEAVY_DIRS.has(lower) || this.excludeSet.has(lower)
  }

  /** Hidden (dot/$ prefixed), HEAVY_DIRS, OS system folders, user excludes — any segment of the path inside its root. */
  isIgnored(vaultPath: string): boolean {
    const segs = segmentsOf(vaultPath)
    return (this.multi ? segs.slice(1) : segs).some((s) => this.ignoredName(s))
  }

  /**
   * abs() for paths that must be inside the visible vault. The name check is
   * lexical and runs first (no fs call for ignored paths); then the path is
   * resolved on disk, so a symlink, a Windows junction or an 8.3 short name
   * (`PROGRA~1`) can neither leave the root nor reach an ignored folder.
   */
  private async allowed(vaultPath: string): Promise<string> {
    const { root } = this.locate(vaultPath)
    const full = this.abs(vaultPath)
    if (this.isIgnored(vaultPath)) throw new Error(`Path is excluded from the vault: ${vaultPath}`)
    const [realRoot, real] = await Promise.all([realish(root.abs), realish(full)])
    const rel = path.relative(realRoot, real)
    if (outside(rel)) throw new Error(`Path escapes vault: ${vaultPath}`)
    if (rel.split(path.sep).some((s) => s && this.ignoredName(s))) {
      throw new Error(`Path is excluded from the vault: ${vaultPath}`)
    }
    return full
  }

  /** allowed() for paths that name a file or folder inside a root (never a root itself). */
  private async entry(vaultPath: string): Promise<string> {
    const full = await this.allowed(vaultPath)
    if (this.isRoot(full)) throw new Error(`Not a path inside the vault: ${vaultPath || '(root)'}`)
    return full
  }

  /** True when `abs` is one of the roots. */
  private isRoot(abs: string): boolean {
    const key = pathKey(abs)
    return this.roots.some((r) => pathKey(r.abs) === key)
  }

  /**
   * Breadth-first walk of every root (one shared queue), collecting markdown
   * notes and folders. Stops after `maxDirs` folders (`truncated`). Symlinks
   * are not followed; unreadable folders are skipped.
   */
  async scan(onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const files: ScanResult['files'] = []
    const folders: string[] = this.multi ? this.roots.map((r) => r.mount) : []
    const rootDirs = new Set(this.roots.map((r) => pathKey(r.abs)))
    const queue = this.roots.map((r) => ({ abs: r.abs, vault: r.mount, root: true }))
    let dirs = 0
    let truncated = false
    let lastReport = Date.now()
    for (let head = 0; head < queue.length; head++) {
      if (dirs >= this.maxDirs) {
        truncated = true
        break
      }
      const dir = queue[head]!
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir.abs, { withFileTypes: true })
      } catch {
        continue
      }
      dirs++
      if (!dir.root) folders.push(dir.vault)
      for (const e of entries) {
        if (this.ignoredName(e.name)) continue
        const abs = path.join(dir.abs, e.name)
        const vault = dir.vault ? `${dir.vault}/${e.name}` : e.name
        if (e.isDirectory()) {
          // A root nested inside another root is walked once, as itself.
          if (!rootDirs.has(pathKey(abs))) queue.push({ abs, vault, root: false })
        } else if (e.isFile() && isNoteName(e.name)) {
          files.push({ path: vault, abs })
        }
      }
      if (onProgress && Date.now() - lastReport >= 120) {
        lastReport = Date.now()
        onProgress({ dirs, found: files.length })
      }
    }
    onProgress?.({ dirs, found: files.length })
    const result: ScanResult = { files, folders, truncated, dirs }
    this.lastScan = result
    return result
  }

  /** Read scanned files with bounded concurrency (32); unreadable files are skipped. Keeps input order. */
  async readAll(
    files: ScanResult['files'],
    onProgress?: (done: number) => void,
  ): Promise<{ path: string; content: string; mtime: number }[]> {
    const out: ({ path: string; content: string; mtime: number } | null)[] = new Array(files.length).fill(null)
    let next = 0
    let done = 0
    let lastReport = Date.now()
    const worker = async () => {
      while (next < files.length) {
        const i = next++
        const f = files[i]!
        try {
          const [content, st] = await Promise.all([fs.readFile(f.abs, 'utf8'), fs.stat(f.abs)])
          out[i] = { path: f.path, content, mtime: st.mtimeMs }
        } catch {
          /* unreadable or vanished: skip */
        }
        done++
        if (onProgress && Date.now() - lastReport >= 120) {
          lastReport = Date.now()
          onProgress(done)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(32, Math.max(1, files.length)) }, worker))
    onProgress?.(done)
    return out.filter((f): f is { path: string; content: string; mtime: number } => f !== null)
  }

  /** File content, or null when missing, unreadable, excluded or not a valid vault path. */
  async read(p: string): Promise<string | null> {
    try {
      return await fs.readFile(await this.allowed(p), 'utf8')
    } catch {
      return null
    }
  }

  /** Atomic write: temp sibling + rename, creating parent folders. Refuses excluded paths. */
  async write(p: string, content: string): Promise<void> {
    const full = await this.entry(p)
    await fs.mkdir(path.dirname(full), { recursive: true })
    // A unique temp name: the app and the AI link may save the same note at the same moment.
    const tmp = tempPath(full)
    try {
      await fs.writeFile(tmp, content, 'utf8')
      await renameRetry(tmp, full)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  }

  /** Delete a file (missing is fine). Refuses folders and excluded paths. */
  async remove(p: string): Promise<void> {
    const full = await this.entry(p)
    let st
    try {
      st = await fs.lstat(full)
    } catch (err) {
      if (errCode(err) === 'ENOENT') return
      throw err
    }
    if (st.isDirectory()) throw new Error(`Refusing to delete a folder: ${p}`)
    try {
      await fs.unlink(full)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err
    }
  }

  /**
   * Move a file or folder, creating the target's parents. Never overwrites an
   * existing target; across drives (another root) it copies, then deletes.
   */
  async rename(from: string, to: string): Promise<void> {
    const a = await this.entry(from)
    const b = await this.entry(to)
    if (a === b) return
    // Checked before anything is created: a missing source fails here.
    const source = await fs.lstat(a, { bigint: true })
    // '' is a case-only rename on Windows (the same path to a case-insensitive compare).
    const into = path.relative(a, b)
    if (into && !outside(into)) throw new Error(`Cannot move a folder into itself: ${to}`)
    const target = await fs.lstat(b, { bigint: true }).catch(() => null)
    // Case-only renames on case-insensitive disks: the "target" is the source itself.
    if (target && (source.ino !== target.ino || source.dev !== target.dev)) {
      throw new Error(`Target already exists: ${to}`)
    }
    await fs.mkdir(path.dirname(b), { recursive: true })
    try {
      await renameRetry(a, b)
    } catch (err) {
      if (errCode(err) !== 'EXDEV') throw err
      await moveAcross(a, b)
    }
  }

  /** Create a folder and any missing parents (a no-op for an existing one). Refuses excluded paths. */
  async mkdir(p: string): Promise<void> {
    await fs.mkdir(await this.allowed(p), { recursive: true })
  }

  /** File/folder info, or null when missing, excluded or not a valid vault path. */
  async stat(p: string): Promise<{ isDir: boolean; isFile: boolean; mtime: number } | null> {
    try {
      const st = await fs.stat(await this.allowed(p))
      return { isDir: st.isDirectory(), isFile: st.isFile(), mtime: st.mtimeMs }
    } catch {
      return null
    }
  }
}
