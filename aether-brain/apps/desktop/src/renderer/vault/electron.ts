import { isAssetPath, isImagePath, mimeOf, type VaultAdapter, type VaultAsset, type VaultChange, type VaultFile, type VaultRootInfo } from '@aether/core'
import type { AetherBridge, InterruptedStartDto, OpenVaultOptions, ReadAssetFailure, VaultChangeDto, VaultInfo } from '../../shared/ipc'

/** A change as main reported it (a picture's comes without content, with its size). */
function toChange(c: VaultChangeDto): VaultChange {
  const out: VaultChange = { kind: c.kind, path: c.path }
  if (c.content !== undefined) out.content = c.content
  if (c.mtime !== undefined) out.mtime = c.mtime
  if (c.size !== undefined) out.size = c.size
  return out
}

/**
 * Most note and folder changes kept for a load that is still running; past
 * that the load is hopelessly behind (see `overflowed`). Picture changes do
 * not count: they are kept only while the held list is shorter than this.
 */
export const MAX_HELD = 20_000

/** A picture's, video's or 3D model's add/change/unlink (folders are never pictures, whatever their name). */
const isPictureChange = (c: VaultChangeDto): boolean => c.kind !== 'addDir' && c.kind !== 'unlinkDir' && isAssetPath(c.path)

/**
 * One or more folders on disk (a multi-root vault can be whole drives such
 * as D:\ + F:\), served by the Electron main process and watched there.
 */
export class ElectronVaultAdapter implements VaultAdapter {
  readonly kind = 'electron' as const
  readonly name: string
  readonly location: string
  readonly readOnly = false
  readonly roots: VaultRootInfo[]
  /** What main reported about the vault (roots, exclusions, folder rules), updated as the folder rules change. */
  get info(): VaultInfo {
    return this.current
  }
  private current: VaultInfo
  /** True when the last folder listing stopped at the folder cap (the tree is partial). */
  truncated = false
  /** True when the last picture listing stopped at the picture cap (some pictures are missing). */
  assetsTruncated = false
  /**
   * True when more than MAX_HELD note and folder changes arrived during the
   * last load, before the app subscribed: they were dropped, so what the app
   * loaded is out of date and only a rescan (reload) brings it back in line.
   * Reset by the next load.
   */
  overflowed = false
  /** Watchers of this adapter, for changes it makes itself (a new folder). */
  private listeners = new Set<(changes: VaultChange[]) => void>()
  /** Changes main reported while a load was running (between list() and watch()). */
  private held: VaultChange[] | null = null
  private offHeld: (() => void) | null = null

  constructor(
    private bridge: AetherBridge,
    info: VaultInfo,
  ) {
    this.current = info
    this.name = info.name
    this.location = info.roots.length > 1 ? info.roots.map((r) => r.path).join(' + ') : info.root
    this.roots = info.roots.map((r) => ({ path: r.path, mount: r.mount, label: r.label }))
  }

  static bridge(): AetherBridge | null {
    return typeof window !== 'undefined' && window.aether ? window.aether : null
  }

  /** An adapter for a vault main already opened (e.g. after adding or removing a root). Throws without the bridge. */
  static fromInfo(info: VaultInfo): ElectronVaultAdapter {
    const b = ElectronVaultAdapter.bridge()
    if (!b) throw new Error('Electron bridge not available')
    return new ElectronVaultAdapter(b, info)
  }

  /** OS folder picker → a single-root vault; null when cancelled or outside Electron. */
  static async pick(): Promise<ElectronVaultAdapter | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    const info = await b.pickVault()
    return info ? new ElectronVaultAdapter(b, info) : null
  }

  /** Open one or more folders as the vault; null outside Electron. Rejects when none can be opened. `pictures: false` leaves pictures and videos out. */
  static async open(roots: string[], opts?: OpenVaultOptions): Promise<ElectronVaultAdapter | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    return new ElectronVaultAdapter(b, await b.openVault(roots, opts))
  }

  /** The open that did not get through last time (the page died while it was opening), or null; asked once as the page starts. */
  static async interrupted(): Promise<InterruptedStartDto | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    try {
      return (await b.startupInterrupted()) ?? null
    } catch {
      return null
    }
  }

  /** Roots to reopen on launch (CLI, AETHER_VAULT or the remembered set), or null. */
  static async last(): Promise<string[] | null> {
    const roots = await ElectronVaultAdapter.bridge()?.lastVault()
    return roots?.length ? roots : null
  }

  /**
   * Every note, read by main. Main starts watching while it reads, and the app
   * subscribes (watch) only after parsing, so changes in between are kept and
   * handed to the first watcher instead of being lost.
   */
  async list(): Promise<VaultFile[]> {
    if (!this.listeners.size) this.hold()
    try {
      // A page at a time (main sends no more than a few MB in one reply); an older main sends them all in an array.
      let page = await this.bridge.listFiles()
      if (Array.isArray(page)) return page
      const files: VaultFile[] = [...page.files]
      while (page.more) {
        page = await this.bridge.listMoreFiles(page.token)
        for (const f of page.files) files.push(f)
      }
      return files
    } catch (err) {
      this.release()
      throw err
    }
  }
  async listFolders(): Promise<string[]> {
    const res = await this.bridge.listFolders()
    this.truncated = res.truncated
    return res.folders
  }
  read(path: string): Promise<string | null> {
    return this.bridge.readFile(path)
  }
  write(path: string, content: string): Promise<void> {
    return this.bridge.writeFile(path, content)
  }
  /** Create a new note; main refuses (the error message carries `EEXIST`) when anything is at the path, in any letter case. */
  create(path: string, content: string): Promise<void> {
    return this.bridge.createFile(path, content)
  }
  remove(path: string): Promise<void> {
    return this.bridge.deleteFile(path)
  }
  rename(from: string, to: string): Promise<void> {
    return this.bridge.renameFile(from, to)
  }
  /** Create a folder (and parents) on disk; emits 'addDir' at once (main's watcher confirms it later). */
  async createFolder(path: string): Promise<void> {
    await this.bridge.createFolder(path)
    const change: VaultChange[] = [{ kind: 'addDir', path }]
    for (const cb of this.listeners) cb(change)
  }
  watch(cb: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(cb)
    const off = this.bridge.onChanges((changes) => cb(changes.map(toChange)))
    const held = this.release()
    if (held.length) cb(held)
    return () => {
      this.listeners.delete(cb)
      off()
    }
  }

  /**
   * Start keeping main's change batches (a load began). Note and folder
   * changes are all kept, up to MAX_HELD of them; past that the load is given
   * up on (`overflowed`). Picture changes only take the room that is left: a
   * reference pack copied in during a long load must not push out the notes'
   * changes, and a missed picture change costs a stale moon, not a stale note.
   */
  private hold(): void {
    this.release()
    this.overflowed = false
    const held: VaultChange[] = []
    let kept = 0
    this.held = held
    this.offHeld = this.bridge.onChanges((changes) => {
      for (const c of changes) {
        if (isPictureChange(c)) {
          if (held.length < MAX_HELD) held.push(toChange(c))
          continue
        }
        if (++kept > MAX_HELD) {
          this.overflowed = true
          this.release()
          return
        }
        held.push(toChange(c))
      }
    })
  }

  /** Stop keeping batches; returns what was kept. */
  private release(): VaultChange[] {
    this.offHeld?.()
    this.offHeld = null
    const held = this.held ?? []
    this.held = null
    return held
  }
  reveal(path: string): Promise<void> {
    return this.bridge.revealInFolder(path)
  }

  /** Every picture main's last scan found (mtime and size where it had time to look). */
  async listAssets(): Promise<VaultAsset[]> {
    const res = await this.bridge.listAssets()
    this.assetsTruncated = res.truncated
    this.lastFiles = res.files ?? []
    return res.assets
  }

  /** The other files the last `listAssets` came with (an mp3, a pdf, a zip); asks again when nothing has asked yet. */
  async listFiles(): Promise<VaultAsset[]> {
    if (this.lastFiles === null) await this.listAssets()
    return this.lastFiles ?? []
  }
  private lastFiles: VaultAsset[] | null = null

  /** A PNG preview at most `size` px on its longer side, made by main's hidden thumbnail helper (off both main and this renderer). */
  async thumbnail(path: string, size: number): Promise<Blob | null> {
    const bytes = await this.bridge.thumbnail(path, size)
    // Bytes that crossed IPC sit in a plain ArrayBuffer, never a shared one.
    return bytes?.length ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : null
  }

  /**
   * The picture file itself, whole: main reads the bytes (at most 64 MB, nothing decoded there) and this side decodes them. Null
   * for a video, a path main refuses, an empty or too big file, and when the read fails: it never rejects.
   */
  async readAsset(path: string): Promise<Blob | null> {
    // A video is a vault asset but not a picture to read whole: no round trip to main for it.
    if (!isImagePath(path)) return null
    try {
      const bytes = await this.bridge.readAsset(path)
      return bytes?.length ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(path) }) : null
    } catch {
      return null
    }
  }

  /**
   * `readAsset` with the reason when there is no picture: main says 'missing', 'too-large' (over 64 MB, or a header that claims more
   * than 150 million pixels: it reads the first 256 KB and judges them) or 'unreadable'. Never rejects. For the docked board, which
   * draws a different placeholder for each.
   */
  async readAssetChecked(path: string): Promise<{ blob: Blob } | { blob: null; reason: ReadAssetFailure; detail: string }> {
    if (!isImagePath(path)) return { blob: null, reason: 'missing', detail: 'That is not a picture of the vault' }
    try {
      const res = await this.bridge.readAssetChecked(path)
      if (res.ok) return res.bytes.length ? { blob: new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(path) }) } : { blob: null, reason: 'unreadable', detail: 'The picture file is empty' }
      return { blob: null, reason: res.reason, detail: res.detail }
    } catch {
      return { blob: null, reason: 'unreadable', detail: 'The picture could not be read' }
    }
  }

  /**
   * A new picture; main refuses (the message carries `EEXIST`) when anything is
   * at the path in any letter case, and anything that is not a real picture of
   * at most 40 MB. Emits 'add' at once (main's watcher confirms it later).
   */
  async createAsset(path: string, data: Uint8Array): Promise<void> {
    await this.bridge.createAsset(path, data)
    const change: VaultChange[] = [{ kind: 'add', path, mtime: Date.now(), size: data.length }]
    for (const cb of this.listeners) cb(change)
  }

  /** Open a picture in the OS default app. */
  openAsset(path: string): Promise<void> {
    return this.bridge.openAsset(path)
  }

  /** Leave a folder out of the brain: main applies it at once and its watcher unlinks what was shown. */
  async hideFolder(path: string): Promise<void> {
    this.current = await this.bridge.hideFolder(path)
  }

  /** Let a folder left out back in: main's watcher walks it and reports what is in it. */
  async unhideFolder(path: string): Promise<void> {
    this.current = await this.bridge.unhideFolder(path)
  }

  /** Replace the folders left out and/or the installs kept (absolute paths), applied at once. */
  async setFolderRules(rules: { hidden?: string[]; keep?: string[] }): Promise<VaultInfo> {
    this.current = await this.bridge.setFolderRules(rules)
    return this.current
  }
}
