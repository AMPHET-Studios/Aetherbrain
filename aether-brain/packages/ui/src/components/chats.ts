import {
  MAX_ENTRY_BYTES,
  blobZipSource,
  describeChatImport,
  isChatExportJson,
  isImagePath,
  readChatExport,
  zipEntries,
  zipRead,
  zipReadText,
  type ExportFile,
  type ZipEntry,
  type ZipSource,
} from '@aether/core'
import { MAX_IMAGE_BYTES, useAether, type ChatImportInput, type ChatImportResult } from '../store'
import { truncate } from '../util'

/**
 * AI chat exports into the brain: Claude's and ChatGPT's data export (the
 * .zip they email, or a `conversations.json` / `projects.json` taken out of
 * it) are read here, in the page, and handed to the store's `importChats`.
 * Zips are read entry by entry (only the chats' JSON and pictures), so a
 * multi-gigabyte export is never loaded whole.
 */

/** A file that looks like a chat export: a .zip or a .json. */
export function isChatExportFile(name: string): boolean {
  return /\.(zip|json)$/i.test(name)
}

/** MIME types a drag reports for chat exports (names are hidden until the drop). */
export function isChatExportType(type: string): boolean {
  return /^application\/(x-)?(zip|zip-compressed|json)$/i.test(type)
}

/** Read the chats of export files; null (with a toast) when nothing could be read. */
export async function readChatFiles(files: readonly File[]): Promise<ChatImportInput | null> {
  const s = useAether.getState()
  const json: ExportFile[] = []
  const pictures = new Map<string, { src: ZipSource; entry: ZipEntry }>()
  const problems: string[] = []
  for (const [i, f] of files.entries()) {
    try {
      if (/\.zip$/i.test(f.name)) {
        const src = blobZipSource(f)
        for (const entry of await zipEntries(src)) {
          if (entry.name.endsWith('/')) continue
          if (isChatExportJson(entry.name)) json.push({ name: `${f.name}/${entry.name}`, text: await zipReadText(src, entry, MAX_ENTRY_BYTES) })
          else if (isImagePath(entry.name) && entry.size <= MAX_IMAGE_BYTES) pictures.set(`${i}/${entry.name}`, { src, entry })
        }
      } else if (/\.json$/i.test(f.name)) {
        json.push({ name: f.name, text: await f.text() })
      } else problems.push(`${truncate(f.name, 48)} is not a chat export (.zip or .json)`)
    } catch (err) {
      const message = err instanceof RangeError ? 'too large to read in one go' : err instanceof Error ? err.message : String(err)
      problems.push(`${truncate(f.name, 48)}: ${message}`)
    }
  }
  for (const p of problems) s.toast(p, 'error')
  if (!json.length) {
    if (!problems.length) s.toast('No chats in that export (Claude: conversations.json, projects.json; ChatGPT: conversations.json)', 'error')
    return null
  }
  const archive = readChatExport(json)
  // A file that did not read (cut off, not JSON) is said, not skipped in silence: its chats are missing.
  if (archive.warnings.length) {
    const first = truncate(archive.warnings[0] ?? '', 90)
    s.toast(`${first}${archive.warnings.length > 1 ? ` (and ${archive.warnings.length - 1} more)` : ''} — was the export cut off? Its chats are not imported`, 'error')
  }
  const input: ChatImportInput = { archive }
  if (pictures.size) {
    input.pictures = {
      files: [...pictures.keys()],
      read: async (path) => {
        const p = pictures.get(path)
        if (!p) throw new Error('not in the export')
        return zipRead(p.src, p.entry, MAX_IMAGE_BYTES)
      },
    }
  }
  return input
}

/** Ask before writing: the plan in a few lines (the system dialog; no dialog → go ahead). */
function confirmImport(input: ChatImportInput): ChatImportInput {
  return {
    ...input,
    confirm: (plan, base) => {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
      const lines = describeChatImport(plan, base)
      const safe = plan.update.length
        ? 'Everything is written as plain markdown. New notes never replace a file; the updated chats get a new transcript, and what you wrote above it stays.'
        : 'Everything is written as plain markdown; nothing in your vault is overwritten.'
      return window.confirm(`Import your AI chats into Aether Brain?\n\n${lines.join('\n')}\n\n${safe}`)
    },
  }
}

/** Read export files and import their chats (after a confirmation). */
export async function importChatFiles(files: readonly File[]): Promise<ChatImportResult | null> {
  const s = useAether.getState()
  if (s.status !== 'ready' || !s.adapter) {
    s.toast('Open your vault first, then import your chats', 'error')
    return null
  }
  if (s.adapter.readOnly) {
    s.toast('This vault is read-only', 'error')
    return null
  }
  s.toast('Reading the export…')
  const input = await readChatFiles(files)
  if (!input) return null
  try {
    return await useAether.getState().importChats(confirmImport(input))
  } catch (err) {
    useAether.getState().toast(`Could not import the chats: ${err instanceof Error ? err.message : String(err)}`, 'error')
    return null
  }
}

/** Pick export files with the system file dialog (never put in the page; needs the user's key or click). */
export function pickChatFiles(onPick: (files: File[]) => void): void {
  if (typeof document === 'undefined') return
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.zip,.json,application/zip,application/json'
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

/** Pick Claude / ChatGPT export files and import their chats. */
export function importChatsFromDialog(): void {
  pickChatFiles((files) => void importChatFiles(files))
}
