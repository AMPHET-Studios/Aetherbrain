/**
 * The start after a crash while a vault was opening (main's startup-guard.ts): the page is told that the last open did not
 * get through, does not reopen the folders by itself, and the welcome screen says so and offers other ways in. This file
 * holds the words and the small store the shell reads; it imports no React and no store, so it is tested on its own.
 */
import type { InterruptedStartDto } from '../shared/ipc'

/** After the page has had a vault loaded for this long (ms), the open counts as having got through. */
export const SETTLE_MS = 60_000

/** "D:\ + F:\" for a few folders, "D:\ + F:\ + G:\ + H:\ + 2 more" for many. */
export function rootsLabel(roots: readonly string[]): string {
  const shown = roots.slice(0, 4).join(' + ')
  return roots.length > 4 ? `${shown} + ${roots.length - 4} more` : shown
}

const count = (v: number | string | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** What the vault held when the page died, in a few words ("303 notes, 140,000 folders, 52,000 pictures"), or ''. */
export function vaultSentence(vault: InterruptedStartDto['vault']): string {
  if (!vault) return ''
  const parts: string[] = []
  const notes = count(vault['notes'])
  const folders = count(vault['folders'])
  const pictures = count(vault['pictures'])
  if (notes !== null) parts.push(`${notes.toLocaleString('en-US')} notes`)
  if (folders !== null) parts.push(`${folders.toLocaleString('en-US')} folders`)
  if (pictures !== null) parts.push(`${pictures.toLocaleString('en-US')} pictures`)
  return parts.length ? `It held ${parts.join(', ')}.` : ''
}

/** The sentence the welcome screen shows (in its red box) when the last open did not get through. */
export function interruptedMessage(d: InterruptedStartDto): string {
  const what = d.died ? 'The window stopped (it ran out of memory or crashed)' : 'Aether Brain was stopped'
  return [
    `${what} while it was opening ${rootsLabel(d.roots)}, so it did not open them again by itself.`,
    d.memory,
    vaultSentence(d.vault),
    'Choose how to go on: the same folders without pictures and videos (the lightest way in), the same folders again, or other folders (a whole drive can hold millions of files; your project folders are far lighter).',
    d.report ? `A report was saved: ${d.report}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

let current: InterruptedStartDto | null = null
const listeners = new Set<() => void>()

/** The note for the welcome screen, or null. */
export const getInterrupted = (): InterruptedStartDto | null => current

export function setInterrupted(d: InterruptedStartDto | null): void {
  current = d
  for (const l of [...listeners]) l()
}

export function subscribeInterrupted(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}
