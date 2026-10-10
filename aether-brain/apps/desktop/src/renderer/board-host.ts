/**
 * The reference board's host for the floating window: `BoardHost` (packages/ui/src/board/api.ts) over the bridge. The window shows
 * one board note and never opens a vault, so everything it needs is a bridge call: the note through `boardRead` / `boardSave`,
 * pictures through `thumbnail`, `readAsset`, `createAsset`, `openAsset`, the vault's list of pictures through `boardAssets` kept
 * right by the picture changes main sends this window (`onChanges`), and the window's own settings through the `board*` calls.
 *
 * No React and no DOM here (Blob and timers only), so it is tested in node with a fake bridge.
 */
import { boardFolderName, boardPictureName, isImagePath, mimeOf, parseBoard, type VaultAsset } from '@aether/core'
import type { BoardHost, BoardWindowHost as BoardWindowControls } from '@aether/ui'
import type { AetherBridge, BoardStatusDto, VaultChangeDto } from '../shared/ipc'

/** How long picture changes are gathered before the picker and the missing-picture marks hear of them (ms). */
export const PICTURE_CHANGE_MS = 150
/** Most numbered names tried for a picture whose name is taken (`name 2`, `name 3` ... `name 99`). */
export const MAX_NAME_TRIES = 99

export interface FloatingBoardOptions {
  /** Shows a toast in the window (the page draws it). */
  toast?: BoardHost['toast']
  /** The clock (names of pasted pictures carry the time). */
  now?: () => Date
  /** What `boardStatus` said, so the window controls are right from the first draw. */
  status?: BoardStatusDto
}

/** The host, and the way to let go of its subscriptions. */
export type FloatingBoardHost = BoardHost & { dispose(): void }

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** The folder a board keeps its pictures in: next to the note, named like it without `.md` (cleaned for the vault: `boardFolderName`). */
export function boardFolderOfPath(boardPath: string): string {
  const slash = boardPath.lastIndexOf('/')
  const dir = slash >= 0 ? boardPath.slice(0, slash + 1) : ''
  return `${dir}${boardFolderName(nameOf(boardPath).replace(/\.md$/i, ''))}`
}

/** The picture type the first bytes say, or '' (PNG, JPEG, GIF, WebP, BMP, AVIF): the extension of a pasted picture whose name has none. */
export function sniffMime(b: Uint8Array): string {
  const at = (i: number, ...bytes: number[]) => bytes.every((v, k) => b[i + k] === v)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(0, 0x42, 0x4d)) return 'image/bmp'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif'
  return ''
}

/** `name.png` → `name 2.png`, `name 3.png` ... (a taken name gets the next number, the way pictures are named everywhere in the app). */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`
}

export function createFloatingBoardHost(bridge: AetherBridge, path: string, opts: FloatingBoardOptions = {}): FloatingBoardHost {
  const toast = opts.toast ?? (() => undefined)
  const now = opts.now ?? (() => new Date())
  const caseSensitive = bridge.platform === 'linux'
  const key = (p: string): string => (caseSensitive ? p : p.toLowerCase())
  const folder = boardFolderOfPath(path)
  let title = nameOf(path).replace(/\.md$/i, '')

  /* ---- the note ---- */

  /** The note as this window last read or wrote it: a read that differs is somebody else's edit. */
  let lastKnown: string | null = null
  /** The text a save is writing right now (its echo from the watcher is ours). */
  let inflight: string | null = null
  /** Saves run one after the other. */
  let writing: Promise<unknown> = Promise.resolve()
  const externalSubs = new Set<() => void>()
  const changedOutside = (): void => {
    for (const cb of [...externalSubs]) cb()
  }

  async function write(raw: string): Promise<void> {
    const current = await bridge.boardRead(path)
    if (current === null) throw new Error('The board note is gone, or is no longer a board: nothing was saved')
    if (lastKnown !== null && current !== lastKnown && current !== raw) {
      // The note changed since this window read it (an editor, the AI link): writing now would erase that edit without a word.
      // It stays refused until the note is read again (load), however often the view tries.
      changedOutside()
      throw new Error('The board was changed outside this window: it has been left as it is. Reload to see the change.')
    }
    inflight = raw
    try {
      const res = await bridge.boardSave(path, raw)
      if (!res.ok) throw new Error(res.reason)
      lastKnown = raw
    } finally {
      inflight = null
    }
  }

  /* ---- pictures ---- */

  /** The vault's pictures, by `key`; null until the first list arrives. */
  let assets: Map<string, VaultAsset> | null = null
  /** The list is partial (the vault has more pictures than main lists): a picture not in it may still be there. */
  let partial = false
  let fetching: Promise<void> | null = null
  /** Picture changes that arrived while a list was being fetched; applied on top of it. */
  let held: VaultChangeDto[] = []
  const changeSubs = new Set<() => void>()
  let changeTimer: ReturnType<typeof setTimeout> | null = null

  const pictureChanged = (): void => {
    if (changeTimer) return
    changeTimer = setTimeout(() => {
      changeTimer = null
      for (const cb of [...changeSubs]) cb()
    }, PICTURE_CHANGE_MS)
  }

  /** Applies one picture change to the list; true when the list changed. */
  function applyPicture(c: VaultChangeDto): boolean {
    if (!assets) return false
    const k = key(c.path)
    if (c.kind === 'unlink') return assets.delete(k)
    const was = assets.get(k)
    const next: VaultAsset = { path: c.path, ...(c.mtime !== undefined ? { mtime: c.mtime } : {}), ...(c.size !== undefined ? { size: c.size } : {}) }
    assets.set(k, next)
    return !was || was.mtime !== next.mtime || was.size !== next.size
  }

  function refresh(): Promise<void> {
    fetching ??= (async () => {
      try {
        const res = await bridge.boardAssets()
        const next = new Map<string, VaultAsset>()
        for (const a of res.assets) if (isImagePath(a.path)) next.set(key(a.path), a)
        const prev = assets
        assets = next
        partial = res.truncated
        // The first list tells what is missing for sure, so it counts as a change; a later one only when it differs (a picker that
        // asks again after every change would never stop).
        let changed = prev === null || prev.size !== next.size
        if (!changed && prev) for (const k of next.keys()) if (!prev.has(k)) changed = true
        const late = held
        held = []
        for (const c of late) changed = applyPicture(c) || changed
        if (changed) pictureChanged()
      } finally {
        held = []
        fetching = null
      }
    })()
    return fetching
  }

  const offChanges = bridge.onChanges((changes) => {
    let pictures = false
    for (const c of changes) {
      if (c.kind === 'addDir' || c.kind === 'unlinkDir') continue
      if (key(c.path) === key(path)) {
        if (c.kind === 'unlink' || (c.content !== undefined && c.content !== lastKnown && c.content !== inflight)) changedOutside()
        continue
      }
      if (!isImagePath(c.path)) continue
      if (fetching) held.push(c)
      else if (applyPicture(c)) pictures = true
    }
    if (pictures) pictureChanged()
  })

  /** Creates one picture in the board's folder under the first free name; its vault path, or null when main refuses the picture. */
  async function addOne(file: { name: string; data: Uint8Array }): Promise<string | null> {
    const base = boardPictureName(file.name, sniffMime(file.data), now())
    for (let n = 1; n <= MAX_NAME_TRIES; n++) {
      const target = `${folder}/${numberedName(base, n)}`
      if (assets?.has(key(target))) continue
      try {
        await bridge.createAsset(target, file.data)
      } catch (err) {
        // A name the list did not know was taken (a picture added since): the next number. Anything else is a refusal.
        if (/EEXIST/.test(errorText(err))) continue
        return null
      }
      if (assets) {
        assets.set(key(target), { path: target, mtime: now().getTime(), size: file.data.length })
        pictureChanged()
      }
      return target
    }
    return null
  }

  /* ---- the window ---- */

  const controls: BoardWindowControls = {
    floating: true,
    alwaysOnTop: opts.status?.alwaysOnTop ?? true,
    opacity: opts.status?.opacity ?? 1,
    supportsOpacity: opts.status?.supportsOpacity ?? false,
    popOut: () => undefined,
    dock: () => {
      // A save in flight finishes first: closing the window would otherwise cut it off.
      void writing.catch(() => undefined).then(() => bridge.boardClose().catch(() => undefined))
    },
    setAlwaysOnTop: (on) => {
      controls.alwaysOnTop = on
      void bridge.boardConfigure({ alwaysOnTop: on }).then(apply, restore)
    },
    setOpacity: (opacity) => {
      if (!Number.isFinite(opacity)) return
      controls.opacity = Math.min(1, Math.max(0.2, opacity))
      void bridge.boardConfigure({ opacity: controls.opacity }).then(apply, restore)
    },
  }
  function apply(s: BoardStatusDto): void {
    controls.alwaysOnTop = s.alwaysOnTop
    controls.opacity = s.opacity
    controls.supportsOpacity = s.supportsOpacity
  }
  /** A change main refused or could not make: show what the window really is. */
  function restore(): void {
    void bridge.boardStatus().then(apply, () => undefined)
  }
  const offState = bridge.onBoardState(apply)
  if (!opts.status) restore()

  void refresh().catch(() => undefined)

  return {
    path,
    get title() {
      return title
    },
    async load() {
      const text = await bridge.boardRead(path)
      if (text === null) throw new Error('This note is not a board, is gone, or is too long to open in the board window')
      lastKnown = text
      title = parseBoard(text).doc.title.trim() || title
      return text
    },
    save(raw) {
      const run = writing.then(() => write(raw))
      writing = run.catch(() => undefined)
      return run
    },
    onExternalChange(cb) {
      externalSubs.add(cb)
      return () => void externalSubs.delete(cb)
    },
    pictures: {
      async preview(p, px) {
        try {
          const bytes = await bridge.thumbnail(p, px)
          return bytes?.length ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : null
        } catch {
          return null
        }
      },
      async original(p) {
        // A video is a vault asset but not a picture to read whole: no round trip for it.
        if (!isImagePath(p)) return null
        try {
          const bytes = await bridge.readAsset(p)
          return bytes?.length ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(p) }) : null
        } catch {
          return null
        }
      },
      async add(files) {
        const out: (string | null)[] = []
        // One after the other: two pictures with the same name must not both take the same number.
        for (const f of files) out.push(await addOne(f))
        return out
      },
      async list() {
        await refresh()
        return assets ? [...assets.values()] : []
      },
      // Until the first list arrives nothing is known to be missing (every picture would flash as a placeholder).
      exists: (p) => assets === null || partial || assets.has(key(p)),
      open: (p) => {
        bridge.openAsset(p).catch((err: unknown) => toast(`Could not open ${nameOf(p)}: ${errorText(err)}`, 'error'))
      },
      reveal: (p) => {
        bridge.revealInFolder(p).catch((err: unknown) => toast(`Could not show ${nameOf(p)}: ${errorText(err)}`, 'error'))
      },
      onChange: (cb) => {
        changeSubs.add(cb)
        return () => void changeSubs.delete(cb)
      },
    },
    toast,
    copyText: (text) => bridge.copyText(text),
    window: controls,
    dispose() {
      offChanges()
      offState()
      if (changeTimer) clearTimeout(changeTimer)
      changeTimer = null
      changeSubs.clear()
      externalSubs.clear()
    },
  }
}
