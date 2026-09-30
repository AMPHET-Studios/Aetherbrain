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

/**
 * Picture extensions: the same list as `isImagePath` in @aether/core (which
 * main cannot import). SVG is left out on purpose: it can carry scripts.
 */
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
/** Names Windows keeps for devices, alone or with an extension (`CON`, `nul.png`). */
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i

/**
 * True for a file name the vault treats as a picture: a picture extension
 * (any case), not an Office owner file (`~$…`). On Windows never a device
 * name (`nul.png`) or NTFS stream syntax (`tool.exe:x.png` names a stream of
 * an executable): picture paths are handed to the OS to open.
 */
export function isImageName(name: string, platform: string = process.platform): boolean {
  if (!IMAGE_RE.test(name) || name.startsWith('~$')) return false
  return platform !== 'win32' || (!name.includes(':') && !WIN_DEVICE.test(name))
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
  /** Picture files (see isImageName), found by name only (no stat), at most `maxAssets`. */
  assets: { path: string; abs: string }[]
  /** True when more pictures were found than `maxAssets` (the list is partial). */
  assetsTruncated: boolean
}

/** A picture with what a stat said about it (both unknown when it was not looked at). */
export interface AssetInfo {
  path: string
  mtime?: number
  size?: number
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

/** The error create() throws when the path is taken (code and message both say EEXIST, so it survives IPC). */
function existsError(vaultPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EEXIST: something already exists at ${vaultPath}`), { code: 'EEXIST' })
}

/** A file name as compared for "the same name": letter case and Unicode normalization ignored. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * `p`, or `fallback` after `ms`: an unreachable network drive can make fs
 * calls hang for a long time. (The call itself keeps running.)
 */
export async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** A unique temp sibling of `full` (ends in TMP_SUFFIX, so scans and watchers skip it). */
function tempPath(full: string): string {
  return `${full}.${Math.random().toString(36).slice(2, 10)}${TMP_SUFFIX}`
}

/**
 * Write a file that must not exist yet (`wx`: EEXIST when anything is there).
 * A write that fails midway removes the file it created.
 */
async function writeNew(full: string, content: string | Uint8Array): Promise<void> {
  const handle = await fs.open(full, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.close()
  } catch (err) {
    await handle.close().catch(() => undefined)
    await fs.rm(full, { force: true }).catch(() => undefined)
    throw err
  }
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
  private readonly maxAssets: number
  private excludeNames: string[] = []
  private excludeSet = new Set<string>()

  constructor(roots: string[], opts: { exclude?: string[]; maxDirs?: number; maxAssets?: number } = {}) {
    const unique = new Map<string, string>()
    for (const r of roots.map((x) => path.resolve(x))) if (!unique.has(pathKey(r))) unique.set(pathKey(r), r)
    if (!unique.size) throw new Error('A vault needs at least one root folder')
    this.roots = FsVault.mountNames([...unique.values()])
    this.multi = this.roots.length > 1
    this.maxDirs = opts.maxDirs ?? 250_000
    this.maxAssets = opts.maxAssets ?? 200_000
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
    return (await this.resolved(vaultPath)).full
  }

  /** allowed(), also returning the path as resolved on disk (`real`: links and short names followed). */
  private async resolved(vaultPath: string): Promise<{ full: string; real: string }> {
    const { root } = this.locate(vaultPath)
    const full = this.abs(vaultPath)
    if (this.isIgnored(vaultPath)) throw new Error(`Path is excluded from the vault: ${vaultPath}`)
    const [realRoot, real] = await Promise.all([realish(root.abs), realish(full)])
    const rel = path.relative(realRoot, real)
    if (outside(rel)) throw new Error(`Path escapes vault: ${vaultPath}`)
    if (rel.split(path.sep).some((s) => s && this.ignoredName(s))) {
      throw new Error(`Path is excluded from the vault: ${vaultPath}`)
    }
    return { full, real }
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
   * notes, pictures (by name, up to `maxAssets`) and folders. Stops after
   * `maxDirs` folders (`truncated`). Symlinks are not followed; unreadable
   * folders are skipped. Remembered as `lastScan`.
   */
  async scan(onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const result = await this.walk(this.roots, onProgress)
    this.lastScan = result
    return result
  }

  /**
   * scan() of one root only, for the watcher's resync after lost events.
   * `dirs` is 0 when the root itself could not be read. Leaves `lastScan` alone.
   */
  scanRoot(root: MountedRoot): Promise<ScanResult> {
    return this.walk([root])
  }

  private async walk(roots: MountedRoot[], onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const files: ScanResult['files'] = []
    const assets: ScanResult['assets'] = []
    let assetsTruncated = false
    const folders: string[] = this.multi ? roots.map((r) => r.mount) : []
    // Every root, not only the walked ones: a root nested inside another is never walked as part of it.
    const rootDirs = new Set(this.roots.map((r) => pathKey(r.abs)))
    const queue = roots.map((r) => ({ abs: r.abs, vault: r.mount, root: true }))
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
        } else if (e.isFile()) {
          if (isNoteName(e.name)) files.push({ path: vault, abs })
          else if (isImageName(e.name)) {
            if (assets.length < this.maxAssets) assets.push({ path: vault, abs })
            else assetsTruncated = true
          }
        }
      }
      if (onProgress && Date.now() - lastReport >= 120) {
        lastReport = Date.now()
        onProgress({ dirs, found: files.length })
      }
    }
    onProgress?.({ dirs, found: files.length })
    return { files, folders, truncated, dirs, assets, assetsTruncated }
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

  /**
   * Scanned pictures with their mtime and size (newest-first moons, the
   * inspector's date), stat'ed with bounded concurrency (32) for at most
   * `budgetMs`: the scan itself never stats a picture, and a whole drive of
   * them (or a share that stopped answering) must not hold up the load. What
   * the budget did not reach, or a stat that failed, is listed without them.
   * Keeps input order.
   */
  async statAssets(assets: ScanResult['assets'], budgetMs = 1500): Promise<AssetInfo[]> {
    const out: AssetInfo[] = assets.map((a) => ({ path: a.path }))
    const deadline = Date.now() + budgetMs
    let next = 0
    const worker = async () => {
      while (next < assets.length && Date.now() < deadline) {
        const i = next++
        const st = await fs.lstat(assets[i]!.abs).catch(() => null)
        if (st?.isFile()) out[i] = { path: assets[i]!.path, mtime: st.mtimeMs, size: st.size }
      }
    }
    const all = Promise.all(Array.from({ length: Math.min(32, assets.length) }, worker))
    // A stat that hangs past the budget is left behind; the copy below is what was known by then.
    await within(all, budgetMs, undefined)
    return out.slice()
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

  /**
   * Create a new file, never replacing anything: it fails with EEXIST when
   * something is already at the path — a note, a folder, a link, repo
   * boilerplate the scan skips (`CHANGELOG.md`), or a name that differs only
   * in letter case (also checked on case-sensitive disks, where the vault
   * still treats them as one note). Parents are made. Refuses excluded paths
   * like write().
   *
   * The content is written in full to a temp sibling first (scans and
   * watchers skip it) and hard-linked into place: a link never replaces
   * anything, and the note never shows up half written (a watcher that read
   * it empty would report an empty note, then take the real content for the
   * echo of our own write). Disks without hard links (FAT, exFAT, some
   * shares) get the file created with `wx` and filled in place. A write that
   * fails midway leaves nothing behind.
   */
  create(p: string, content: string): Promise<void> {
    return this.createNew(p, content)
  }

  /**
   * Create a new picture from its bytes (a dropped file, a Concept Forge
   * drawing) with exactly create()'s rules: EEXIST when anything is at the
   * path in any letter case, never shown half written, parents made,
   * excluded paths refused. Picture names only (isImageName).
   */
  async createBinary(p: string, data: Uint8Array): Promise<void> {
    if (!isImageName(segmentsOf(p).at(-1) ?? '')) throw new Error(`Not a picture file name: ${p}`)
    await this.createNew(p, data)
  }

  /**
   * Absolute path of a picture in the visible vault (to thumbnail it or open
   * it with the OS), or null: not a picture name, outside the vault or in a
   * skipped folder, missing, or not a plain file (a folder, a link). The name
   * is checked again as resolved on disk, so an 8.3 short name (`TOOL~1.PNG`
   * for `tool.pngx`) never passes for a picture.
   */
  async assetAbs(p: string): Promise<string | null> {
    // Lexical first: no fs call for anything that is not a picture name.
    if (!isImageName(segmentsOf(p).at(-1) ?? '')) return null
    try {
      const { full, real } = await this.resolved(p)
      if (this.isRoot(full) || !isImageName(path.basename(real))) return null
      return (await fs.lstat(full)).isFile() ? full : null
    } catch {
      return null
    }
  }

  /** create() and createBinary(): see create(). */
  private async createNew(p: string, content: string | Uint8Array): Promise<void> {
    const full = await this.entry(p)
    const dir = path.dirname(full)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (err) {
      // A file where the folder should be: not "this name is taken" (another suffix would not help).
      if (errCode(err) !== 'EEXIST') throw err
      throw Object.assign(new Error(`Not a folder: ${path.posix.dirname(p.replace(/\\/g, '/'))}`), { code: 'ENOTDIR' })
    }
    const key = nameKey(path.basename(full))
    if ((await fs.readdir(dir)).some((n) => nameKey(n) === key)) throw existsError(p)
    const tmp = tempPath(full)
    await writeNew(tmp, content)
    let linkErr: unknown
    let linked = false
    try {
      await fs.link(tmp, full)
      linked = true
    } catch (err) {
      linkErr = err
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
    if (linked) return
    if (errCode(linkErr) === 'EEXIST') throw existsError(p)
    // No hard links here: create it in place (a reader may see it empty for a moment).
    try {
      await writeNew(full, content)
    } catch (err) {
      throw errCode(err) === 'EEXIST' ? existsError(p) : err
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
