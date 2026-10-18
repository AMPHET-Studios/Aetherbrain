/**
 * Desktop-only overlay state (which panel is open, the AI activity feed) and
 * the helpers the two panels share. Tiny external stores read with
 * useSyncExternalStore: the app store stays free of desktop concerns.
 */
import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { folderKey, idFromPath, imageKey, isAssetPath } from '@aether/core'
import { useAether } from '@aether/ui'
import type { AiActivityDto, AiShowDto } from '../shared/ipc'

/** roots: vault folders · drives: pick whole drives to mirror · ai: the AI link · library: the librarian · find: Find projects. */
export type PanelId = 'roots' | 'drives' | 'ai' | 'library' | 'find'

let current: PanelId | null = null
const panelSubs = new Set<() => void>()

/** Open a panel (null closes). The palette and the cheatsheet close first; views stay behind it. */
export function openPanel(id: PanelId | null): void {
  if (current === id) return
  if (id) {
    const s = useAether.getState()
    if (s.paletteOpen) s.setPalette(false)
    if (s.helpOpen) s.setHelp(false)
  }
  current = id
  for (const cb of panelSubs) cb()
}

export function togglePanel(id: PanelId): void {
  openPanel(current === id ? null : id)
}

function subscribePanel(cb: () => void): () => void {
  panelSubs.add(cb)
  return () => panelSubs.delete(cb)
}

export function usePanel(): PanelId | null {
  return useSyncExternalStore(subscribePanel, () => current)
}

/* ------------------------------------------------------------------ */
/* AI activity feed                                                   */
/* ------------------------------------------------------------------ */

export interface FeedItem extends AiActivityDto {
  seq: number
  at: number
}

let feed: FeedItem[] = []
let feedSeq = 0
const feedSubs = new Set<() => void>()

/** Remember one AI tool call (newest first, last 60). */
export function pushActivity(a: AiActivityDto): void {
  feed = [{ ...a, seq: ++feedSeq, at: Date.now() }, ...feed].slice(0, 60)
  for (const cb of feedSubs) cb()
}

function subscribeFeed(cb: () => void): () => void {
  feedSubs.add(cb)
  return () => feedSubs.delete(cb)
}

export function useActivity(): FeedItem[] {
  return useSyncExternalStore(subscribeFeed, () => feed)
}

/**
 * True for a tool call that failed. The activity event has no error flag;
 * the server reports a failure as `<tool> failed: <reason>`.
 */
export function activityFailed(a: Pick<AiActivityDto, 'tool' | 'summary'>): boolean {
  return !!a.tool && a.summary.startsWith(`${a.tool} failed:`)
}

/** "Claude", "ChatGPT" or the client's own name, for toasts and the feed. */
export function clientLabel(client: string): string {
  if (/claude|anthropic/i.test(client)) return 'Claude'
  if (/openai|chatgpt/i.test(client)) return 'ChatGPT'
  return client.trim() || 'An AI'
}

let cancelFly: (() => void) | null = null

/**
 * Select and fly to the note (or folder) at a vault path. An AI write shows
 * up through the watcher a moment later, so wait for it to enter the graph
 * (up to 6 s). Only the latest request is kept.
 */
export function flyToPath(path: string): void {
  cancelFly?.()
  cancelFly = null
  // A note, a picture an AI sent (save_image), or else a folder (create_folder).
  const id = /\.md$/i.test(path) ? idFromPath(path) : isAssetPath(path) ? imageKey(path) : folderKey(path)
  const tryFly = (): boolean => {
    const s = useAether.getState()
    if (s.status !== 'ready' || !s.graph?.index.has(id)) return false
    s.select(id, { fly: true })
    return true
  }
  if (tryFly()) return
  const unsub = useAether.subscribe((s, prev) => {
    if (s.graph !== prev.graph && tryFly()) stop()
  })
  const timer = setTimeout(() => stop(), 6000)
  const stop = () => {
    unsub()
    clearTimeout(timer)
    if (cancelFly === stop) cancelFly = null
  }
  cancelFly = stop
}

/**
 * An AI asked to show something (show_in_brain): fly to it and select it, the same way the app's own "go to" does. A picture
 * that is not in the graph yet becomes a moon to be (the store knows how), a folder is shown as a star, a note can open in the
 * editor too. Never takes the camera away from a note being typed: it says so instead.
 */
export function showForAi(t: AiShowDto): void {
  const s = useAether.getState()
  if (s.status !== 'ready') return
  const name = t.kind === 'today' ? 'the Today hub' : t.path.slice(t.path.lastIndexOf('/') + 1).replace(/\.md$/i, '') || 'the vault'
  if (s.dirty) {
    s.toast(`An AI wants to show you ${name}. Save your note, then ask again.`, 'info')
    return
  }
  switch (t.kind) {
    case 'today':
      s.showToday()
      return
    case 'folder':
      s.showFolder(t.path)
      return
    case 'picture':
      s.showPicture(t.path)
      return
    case 'note': {
      const id = idFromPath(t.path)
      if (t.open && s.notes.has(id)) s.openNote(id, { fly: true })
      else flyToPath(t.path)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Save the note being edited before the vault is reopened: reopening drops
 * the draft, and afterwards its path may not exist any more (a root added or
 * removed changes every path). False when an unsaved draft is left (the save
 * failed and toasted why).
 */
export async function saveOpenNote(): Promise<boolean> {
  const s = useAether.getState()
  if (s.dirty) await s.saveDraft()
  return !useAether.getState().dirty
}

/** Shown when saveOpenNote() leaves a draft behind. */
export const UNSAVED_NOTE = 'The note you are editing could not be saved. Save it (or undo the edit) first, then try again.'

/** A readable message from a rejected IPC call (drops Electron's "Error invoking remote method" prefix). */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

/** Same paths compared the way the OS does (Windows paths are case-insensitive). */
export function samePath(a: string, b: string, platform: string): boolean {
  const norm = (p: string) => (platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p)
  return norm(a) === norm(b)
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return type !== 'checkbox' && type !== 'radio' && type !== 'button'
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)] : []
}

/** The overlay that owns the keyboard right now (the one mounted last). */
let active: { ref: RefObject<HTMLElement | null>; keys: Record<string, () => void> } | null = null

/**
 * One window listener in the capture phase, registered when this module loads
 * so it runs before every other key handler (the app's shortcuts, the review
 * and projects views): while an overlay is open no key reaches anything behind
 * it. Default actions still happen, so typing, Tab, Enter and Space work on
 * the overlay's own controls.
 */
function onOverlayKey(e: KeyboardEvent): void {
  if (!active) return
  e.stopImmediatePropagation()
  const { ref, keys } = active
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey
  if (e.key === 'Escape') {
    e.preventDefault()
    openPanel(null)
    return
  }
  const run = keys[e.key]
  if (run && plain && !isTyping(e.target)) {
    e.preventDefault()
    run()
    return
  }
  if (e.key !== 'Tab') return
  const els = focusables(ref.current)
  const first = els[0]
  const last = els[els.length - 1]
  if (!first || !last) return
  const focused = document.activeElement
  if (!ref.current?.contains(focused)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  } else if (e.shiftKey && focused === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && focused === last) {
    e.preventDefault()
    first.focus()
  }
}

if (typeof window !== 'undefined') window.addEventListener('keydown', onOverlayKey, true)

/**
 * Keyboard for a desktop overlay while it is mounted: focus goes to its first
 * control (or the one marked `data-autofocus`); Esc closes it; single keys in
 * `keys` run their action (the panel's own key closes it, the other panel's
 * key switches); Tab stays inside it; nothing behind it hears a key. Focus
 * returns where it was on close.
 */
export function useOverlayKeys(ref: RefObject<HTMLElement | null>, keys: Record<string, () => void>): void {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const mine = { ref, keys }
    active = mine
    const raf = requestAnimationFrame(() => {
      const root = ref.current
      ;(root?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ?? focusables(root)[0])?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      if (active === mine) active = null
      if (before?.isConnected) before.focus()
    }
    // Mount-only: an overlay's keys never change while it is open.
  }, [])
}
