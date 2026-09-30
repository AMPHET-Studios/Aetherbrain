import { useEffect, useState } from 'react'
import { IMAGE_EXTENSIONS, imageFileName, isImagePath, type VaultAsset } from '@aether/core'
import { MAX_IMAGE_BYTES, useAether } from '../store'
import { plural, truncate } from '../util'

/**
 * Most bytes read into memory for one `importImages` call. A drop of a whole
 * photo folder goes in several calls, so the renderer never holds gigabytes.
 */
const CHUNK_BYTES = 256 * 1024 * 1024

/** What the file dialog offers: the picture types the vault shows (no SVG, HEIC, TIFF … it would then ignore). */
const ACCEPT = IMAGE_EXTENSIONS.map((e) => `.${e}`).join(',')

/**
 * Save dropped or picked files into the vault as pictures (`importImages`).
 * Files that are not pictures by name, or over 40 MB, are reported and never
 * read. The target is fixed before the first file is read (`folder`, else the
 * store's `importTarget()`): the import selects the first new picture, which
 * must not move later chunks to another folder. Returns the paths written.
 */
export async function importPictureFiles(files: readonly File[], folder?: string): Promise<string[]> {
  const s = useAether.getState()
  const pictures: File[] = []
  const refused: string[] = []
  const tooBig: string[] = []
  for (const f of files) {
    if (!isImagePath(f.name)) refused.push(f.name)
    else if (f.size > MAX_IMAGE_BYTES) tooBig.push(f.name)
    else pictures.push(f)
  }
  if (refused.length) {
    const what = refused.length === 1 ? `${truncate(refused[0] ?? '', 48)} is not a picture` : `${refused.length} files are not pictures`
    s.toast(`${what} (${IMAGE_EXTENSIONS.join(', ')})`, 'error')
  }
  if (tooBig.length) s.toast(`${tooBig.length === 1 ? truncate(tooBig[0] ?? '', 48) : plural(tooBig.length, 'picture')} over 40 MB, not added`, 'error')
  if (!pictures.length) return []
  const target = folder ?? s.importTarget()
  if (target === null) return []

  const written: string[] = []
  let chunk: { name: string; data: Uint8Array }[] = []
  let bytes = 0
  /** Save the files read so far; false (with a toast) when the store failed outright, so the rest is not read. */
  const flush = async (): Promise<boolean> => {
    if (!chunk.length) return true
    const batch = chunk
    chunk = []
    bytes = 0
    try {
      written.push(...(await useAether.getState().importImages(batch, target)))
      return true
    } catch (err) {
      useAether.getState().toast(`Could not add the pictures: ${err instanceof Error ? err.message : String(err)}`, 'error')
      return false
    }
  }
  for (const f of pictures) {
    if (bytes > 0 && bytes + f.size > CHUNK_BYTES && !(await flush())) return written
    try {
      chunk.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })
      bytes += f.size
    } catch (err) {
      // Moved or deleted after it was picked, or a folder dropped as a file.
      useAether.getState().toast(`Could not read ${truncate(f.name, 48)}: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }
  await flush()
  return written
}

/**
 * Ask for picture files with the system file dialog. The input is never put
 * in the page, so any command can open it; the dialog needs the user's
 * gesture (a click, or the palette's Enter) to be allowed to open.
 */
export function pickPictureFiles(onPick: (files: File[]) => void): void {
  if (typeof document === 'undefined') return
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = ACCEPT
  input.addEventListener(
    'change',
    () => {
      const files = [...(input.files ?? [])]
      if (files.length) onPick(files)
    },
    { once: true },
  )
  input.click()
}

/** Pick pictures and import them (into `folder`, else where `importImages` puts them). */
export function importPicturesFromDialog(folder?: string): void {
  pickPictureFiles((files) => void importPictureFiles(files, folder))
}

/** What a wikilink target can't hold: `#` starts a heading, `|` an alias, a bracket ends the link. */
const NOT_IN_WIKILINK = /[#[\]|]/

/**
 * The `![[…]]` that embeds a picture: its file name, or its vault path when
 * another picture has the same name (in any letter case), so the embed can't
 * resolve to the other one. An error instead when that text holds `#`, `[`,
 * `]` or `|` (all legal in Windows file names): such an embed would link to a
 * heading of a note, or to nothing.
 */
export function embedOf(path: string, assets: ReadonlyMap<string, VaultAsset>): { embed: string } | { error: string } {
  const name = imageFileName(path)
  const lower = name.toLowerCase()
  let target = name
  let same = 0
  for (const p of assets.keys()) {
    if (imageFileName(p).toLowerCase() === lower && ++same > 1) {
      target = path
      break
    }
  }
  // Name the part to rename: the file, or the folder of the path that has to be written out.
  const bad = target.split('/').find((seg) => NOT_IN_WIKILINK.test(seg))
  if (bad !== undefined) return { error: `Rename “${truncate(bad, 64)}” to embed it: # [ ] | can’t be in a wikilink` }
  return { embed: `![[${target}]]` }
}

/**
 * Put text on the clipboard. The desktop's sandboxed renderer may be denied
 * `navigator.clipboard`; the bridge's `copyText` does it from the main process.
 */
export async function copyText(text: string): Promise<void> {
  const bridge = (globalThis as { aether?: { copyText?(text: string): Promise<void> } }).aether
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('No clipboard here')
    await navigator.clipboard.writeText(text)
  } catch (err) {
    if (!bridge?.copyText) throw err
    await bridge.copyText(text)
  }
}

/** Copy a picture's embed and say so (a toast either way; nothing is copied when no embed can link to it). */
export async function copyEmbed(path: string): Promise<void> {
  const s = useAether.getState()
  const res = embedOf(path, s.assets)
  if ('error' in res) {
    s.toast(res.error, 'error')
    return
  }
  const { embed } = res
  try {
    await copyText(embed)
    s.toast(`Copied ${embed} — paste it into a note`, 'success')
  } catch (err) {
    s.toast(`Could not copy ${embed}: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/** Preview size asked of the adapter (px, longer side): sharp in the inspector and in a note's preview on a 2× screen. */
const PREVIEW_SIZE = 512

export type Preview = { url: string | null; state: 'loading' | 'ready' | 'none' }

/**
 * A picture's preview (`store.preview`, `PREVIEW_SIZE`) as an object URL,
 * revoked when the picture changes or the component unmounts. The store
 * keeps no previews: `stamp` changes when the file does.
 */
export function usePreview(path: string, stamp: string): Preview {
  const adapter = useAether((s) => s.adapter)
  const preview = useAether((s) => s.preview)
  const [state, setState] = useState<Preview>({ url: null, state: 'loading' })
  useEffect(() => {
    if (!adapter?.thumbnail) {
      setState({ url: null, state: 'none' })
      return
    }
    let live = true
    let url: string | null = null
    setState({ url: null, state: 'loading' })
    void preview(path, PREVIEW_SIZE).then((blob) => {
      if (!live) return
      if (!blob) return setState({ url: null, state: 'none' })
      url = URL.createObjectURL(blob)
      setState({ url, state: 'ready' })
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [adapter, preview, path, stamp])
  return state
}

/** A file size for people: `812 B`, `4.2 KB`, `31 KB`, `2.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
