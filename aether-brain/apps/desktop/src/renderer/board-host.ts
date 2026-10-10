/**
 * The reference board's host for the floating window: `BoardHost` (packages/ui/src/board/api.ts) over the bridge. The window shows
 * one board note and never opens a vault, so everything it needs is a bridge call: the note through `boardRead` / `boardSave`,
 * pictures through `thumbnail`, `readAssetChecked`, `createAsset`, `openAsset`, the vault's list of pictures through `boardAssets` kept
 * right by the picture changes main sends this window (`onChanges`), and the window's own settings through the `board*` calls.
 * The bridge here is the board page's own (BoardBridge, board-preload.cts): nothing outside this list exists on it.
 *
 * A save is ONE call, `boardSave(path, text, expectedBase)`: main compares the note on disk with the text the save was made from and
 * writes, so a save that begins as the window closes is complete once main has the message (the two-step read-then-write it
 * replaced was cut off when the page went between the steps).
 *
 * No React and no DOM here (Blob and timers only), so it is tested in node with a fake bridge.
 */
import { boardFolderName, boardPictureName, isImagePath, mimeOf, parseBoard, type VaultAsset } from '@aether/core'
import type { BoardHost, BoardWindowHost as BoardWindowControls } from '@aether/ui'
import type { BoardBridge, BoardStatusDto, VaultChangeDto } from '../shared/ipc'

/** How long picture changes are gathered before the picker and the missing-picture marks hear of them (ms). */
export const PICTURE_CHANGE_MS = 150
/** Most numbered names tried for a picture whose name is taken (`name 2`, `name 3` ... `name 99`). */
export const MAX_NAME_TRIES = 99
/** How many of its own texts the window remembers to tell the watcher's echo of a save from somebody else's edit. */
export const ECHO_TEXTS = 4

export interface FloatingBoardOptions {
  /** Shows a toast in the window (the page draws it). */
  toast?: BoardHost['toast']
  /** The clock (names of pasted pictures carry the time). */
  now?: () => Date
  /** What `boardStatus` said, so the window controls are right from the first draw. */
  status?: BoardStatusDto
}

/**
 * The host, and the way to let go of its subscriptions. `latestText` is the newest text of the note this window read or tried to write
 * (null before the first read): what "Copy board text" copies when the note is gone and cannot take a save.
 */
export type FloatingBoardHost = BoardHost & { dispose(): void; latestText(): string | null }

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

export function createFloatingBoardHost(bridge: BoardBridge, path: string, opts: FloatingBoardOptions = {}): FloatingBoardHost {
  const toast = opts.toast ?? (() => undefined)
  const now = opts.now ?? (() => new Date())
  const caseSensitive = bridge.platform === 'linux'
  const key = (p: string): string => (caseSensitive ? p : p.toLowerCase())
  const folder = boardFolderOfPath(path)
  /** Where new pictures go: the board's own folder, or `<name> pictures` once a picture has been placed there because the vault leaves the first out. */
  let pictureFolder = folder
  let title = nameOf(path).replace(/\.md$/i, '')

  /* ---- the note ---- */

  /** The note as this window last read or wrote it: a read that differs is somebody else's edit. */
  let lastKnown: string | null = null
  /** The newest text this window read or tried to write, a refused try included (see `latestText`). */
  let latest: string | null = null
  /**
   * The last few texts this window read or wrote, newest last. The watcher reports each save a moment after it (and a slow report
   * can arrive after the next save has begun), so a change carrying one of these is our own echo, not somebody else's edit. Bounded:
   * a note is at most 1,000,000 characters.
   */
  const echoes: string[] = []
  const remember = (text: string): void => {
    const at = echoes.indexOf(text)
    if (at >= 0) echoes.splice(at, 1)
    echoes.push(text)
    if (echoes.length > ECHO_TEXTS) echoes.shift()
  }
  /** Saves run one after the other. */
  let writing: Promise<unknown> = Promise.resolve()
  const externalSubs = new Set<() => void>()
  const changedOutside = (): void => {
    for (const cb of [...externalSubs]) cb()
  }

  /**
   * One call: main compares the note on disk with `base` (the text `raw` was made from: the view's, else the last this host read or
   * wrote) and writes. A note that changed since (an editor, the AI link, a sync tool) is refused with `changed`: writing would erase
   * that edit without a word, and the refusal stays until the note is read again (load), however often the view tries.
   */
  async function write(raw: string, expectedBase?: string): Promise<void> {
    // Before the call: the watcher may report the write before the answer to it gets back here.
    remember(raw)
    latest = raw
    const res = await bridge.boardSave(path, raw, expectedBase ?? lastKnown ?? undefined)
    if (!res.ok) {
      // Refused, so nothing of it is on disk: it is no echo of ours.
      const at = echoes.lastIndexOf(raw)
      if (at >= 0) echoes.splice(at, 1)
      if (res.changed) changedOutside()
      throw new Error(res.reason)
    }
    lastKnown = raw
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
        if (c.kind === 'unlink' || (c.content !== undefined && c.content !== lastKnown && !echoes.includes(c.content))) changedOutside()
        continue
      }
      if (!isImagePath(c.path)) continue
      if (fetching) held.push(c)
      else if (applyPicture(c)) pictures = true
    }
    if (pictures) pictureChanged()
  })

  /** Creates one picture in `dir` under the first free name: its vault path, or why the vault refused it (a taken name is not a refusal, the next number is tried). */
  async function putIn(dir: string, base: string, data: Uint8Array): Promise<string | { why: string }> {
    for (let n = 1; n <= MAX_NAME_TRIES; n++) {
      const target = `${dir}/${numberedName(base, n)}`
      if (assets?.has(key(target))) continue
      try {
        await bridge.createAsset(target, data)
      } catch (err) {
        const why = errorText(err)
        // A name the list did not know was taken (a picture added since): the next number.
        if (/EEXIST/.test(why)) continue
        return { why }
      }
      if (assets) {
        assets.set(key(target), { path: target, mtime: now().getTime(), size: data.length })
        pictureChanged()
      }
      return target
    }
    return { why: `More than ${MAX_NAME_TRIES} pictures already have that name` }
  }

  /** What a refusal from main means for the user (the generic "a type it does not know, or over 40 MB" is right for the other two). */
  const EXCLUDED = /excluded from the vault/i
  const generic = (why: string): boolean => /too big|Not a picture|empty/i.test(why)

  /**
   * Creates one picture in the board's folder; its vault path, or null when main refuses the picture. The folder is one the vault may
   * leave out (a name in the user's exclude list): then, once, beside it in `<name> pictures` - and that folder becomes the board's
   * only when the picture really went there, so a file name the vault refuses in either folder (`$R1A2.png`) never moves the folder.
   */
  async function addOne(file: { name: string; data: Uint8Array }, said: string[]): Promise<string | null> {
    const base = boardPictureName(file.name, sniffMime(file.data), now())
    let got = await putIn(pictureFolder, base, file.data)
    if (typeof got !== 'string' && pictureFolder === folder && EXCLUDED.test(got.why)) {
      const beside = `${folder} pictures`
      const second = await putIn(beside, base, file.data)
      if (typeof second === 'string') pictureFolder = beside
      got = second
    }
    if (typeof got === 'string') return got
    if (!generic(got.why)) said.push(EXCLUDED.test(got.why) ? `${nameOf(base)} was not added: the vault leaves out names like that (one that starts with $ or a dot, or a folder you excluded)` : `${nameOf(base)} was not added: ${got.why}`)
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
      // A note too long for the window rejects with its own sentence; null is a note that is gone or no longer a board.
      const text = await bridge.boardRead(path).catch((err: unknown) => {
        throw new Error(errorText(err))
      })
      if (text === null) throw new Error('This note is gone, or is no longer a board (type: board in its frontmatter)')
      lastKnown = text
      latest = text
      remember(text)
      title = parseBoard(text).doc.title.trim() || title
      return text
    },
    save(raw, expectedBase) {
      const run = writing.then(() => write(raw, expectedBase))
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
        let res: Awaited<ReturnType<BoardBridge['readAssetChecked']>>
        try {
          res = await bridge.readAssetChecked(p)
        } catch {
          return null
        }
        if (res.ok) return res.bytes.length ? new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: mimeOf(p) }) : null
        // Main says why there are no bytes (a verdict about the file, or a file that is gone); the picture cache keeps it.
        throw Object.assign(new Error(res.detail), { reason: res.reason })
      },
      async add(files) {
        const out: (string | null)[] = []
        const said: string[] = []
        // One after the other: two pictures with the same name must not both take the same number.
        for (const f of files) out.push(await addOne(f, said))
        // A refusal that is not a type or a size: the view's own line ("a type it does not know, or over 40 MB") would be wrong, so say what it was.
        if (said.length) toast(said.length === 1 ? said[0]! : `${said[0]!} (and ${said.length - 1} more)`, 'error')
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
    latestText: () => latest,
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
