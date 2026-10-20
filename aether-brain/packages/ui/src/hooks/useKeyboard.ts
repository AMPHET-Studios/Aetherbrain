import { useEffect } from 'react'
import { folderPathOf, imagePathOf, isFolderId, isImageId, isTodayId } from '@aether/core'
import { selectedProject, sunTargetOf } from '../commands'
import { keyToCommand } from '../board/commands'
import { importChatsFromDialog } from '../components/chats'
import { focusBrief } from '../components/Inspector'
import { useAether } from '../store'
import { isControl, isTyping } from '../util'

/** Single-key shortcuts added by the host app (e.g. the desktop's `v` and `a` panels). */
const extraKeys = new Map<string, () => void>()

/**
 * Add a single-key shortcut from outside the package (desktop-only UI). It
 * gets the same guards as the built-in single keys (not while typing, not
 * with ⌘/Ctrl/Alt, not over the palette or the cheatsheet), and built-in
 * keys win on conflicts. Returns a function that unregisters it.
 */
export function registerKey(key: string, run: () => void): () => void {
  extraKeys.set(key, run)
  return () => {
    if (extraKeys.get(key) === run) extraKeys.delete(key)
  }
}

/**
 * Global keyboard map. Text fields keep their keys; everything else is
 * single-key so the graph can be driven without a mouse.
 * See docs/KEYBOARD.md.
 */
export function useKeyboard(): void {
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])
}

/**
 * Keys that the Boards view leaves to the app: the board (or the list of boards) owns the rest of the keyboard, because its keys are the
 * 3D view's letters (b, l, t, m, z, e ...) and `1`. These are views and help, none of them a board key.
 */
const BOARDS_VIEW_KEYS: ReadonlySet<string> = new Set(['?', '/', '2', '3', '4', '5', '6', '7'])

/** Whether the board has a use for this key (a command, a nudge, Space), as the board's own handler would decide. */
function boardOwns(e: KeyboardEvent): boolean {
  if (e.key === ' ' || e.key.startsWith('Arrow')) return true
  const id = keyToCommand(
    { key: e.key, code: e.code ?? '', down: true, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat === true },
    { tool: 'select', editing: false, cropping: false },
  )
  return id !== null
}

/** The global keydown handler (exported for tests). */
export function handleKey(e: KeyboardEvent): void {
  const s = useAether.getState()
  const mod = e.metaKey || e.ctrlKey

  // Always-on chords (work inside inputs too).
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    s.setPalette(!s.paletteOpen)
    return
  }
  if (mod && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    s.setView('capture')
    return
  }
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault()
    s.goBack()
    return
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault()
    s.goForward()
    return
  }
  if (e.key === 'Escape') {
    if (s.helpOpen) return s.setHelp(false)
    if (s.paletteOpen) return s.setPalette(false)
    // In the Boards view a text field of the view (a note being written, the picker's search) keeps its own Esc.
    if (s.view === 'boards' && isTyping(e)) {
      ;(e.target as HTMLElement).blur()
      return
    }
    if (s.view === 'capture' || s.view === 'review' || s.view === 'projects' || s.view === 'boards') return s.setView('graph')
    if (s.editorId && s.view === 'editor') return s.closeEditor()
    if (isTyping(e)) {
      ;(e.target as HTMLElement).blur()
      return
    }
    if (s.editorId) return s.closeEditor()
    if (s.filters.query || s.filters.areas.size || s.filters.tags.size || s.filters.types.size || s.filters.bodies.size) return s.clearFilters()
    if (s.selectedId) return s.select(null)
    return
  }

  if (isTyping(e) || mod || e.altKey) return
  if (s.paletteOpen || s.helpOpen) return

  // The Boards view owns the keyboard: the board consumes its keys before they get here (capture phase), and this makes sure the 3D
  // view's single keys never also fire for the ones it leaves, or while the list of boards is showing.
  if (s.view === 'boards') {
    // 8 and Shift+B inside the view are "up": from a board to the list, from the list back to the board last open.
    if (e.key === '8' || ((e.key === 'B' || e.key === 'b') && e.shiftKey)) {
      e.preventDefault()
      s.openBoards()
      return
    }
    if (!BOARDS_VIEW_KEYS.has(e.key)) {
      // Keys the desktop adds (w pops the board out) work, unless the board has a use for the same key.
      const extra = extraKeys.get(e.key) ?? (e.shiftKey ? undefined : extraKeys.get(e.key.toLowerCase()))
      if (extra && !boardOwns(e)) {
        e.preventDefault()
        extra()
      }
      return
    }
  }

  const cam = s.controller.camera
  switch (e.key) {
    case '/':
    case '4':
      e.preventDefault()
      s.setPalette(true)
      return
    case 'c':
    case '3':
      e.preventDefault()
      s.setView('capture')
      return
    case '1':
      s.setView('graph')
      return
    case '2':
      if (s.editorId) s.setView('editor')
      else if (s.selectedId && s.notes.has(s.selectedId)) s.openNote(s.selectedId, { fly: true })
      return
    case '5':
    case 'r':
      s.setView('review')
      return
    case '6':
    case 'p': {
      // A selected project star opens its own board.
      const project = selectedProject(s)
      if (project) s.selectProject(project)
      s.setView('projects')
      return
    }
    case 'e':
    case 'Enter':
      // Enter on a focused button or link is that control's own (Expand, ✕, a toast's Undo …).
      if (e.key === 'Enter' && isControl(e.target)) return
      // Enter while a star's live screen is open (Concept Forge) opens its app, unless something else is selected.
      if (e.key === 'Enter' && s.controller.screenOpen && (!s.selectedId || s.selectedId === s.controller.screen?.star)) {
        e.preventDefault()
        s.controller.activateScreen()
        return
      }
      if (!s.selectedId) return
      // A picture opens in the OS image app; the Today hub opens its brief (focus on the first task).
      if (isImageId(s.selectedId)) void s.openImage(imagePathOf(s.selectedId))
      else if (isTodayId(s.selectedId)) {
        if (focusBrief(false)) e.preventDefault()
      } else s.openNote(s.selectedId, { fly: true })
      return
    case 'y':
    case '7':
      s.showToday()
      return
    case '8':
      // Reference boards: the board last open, else the list (inside the view: see above).
      s.openBoards()
      return
    case 'u':
      // The newest toast's action: Undo a tick from the brief, Show a picture just imported.
      if (s.toastAction()) e.preventDefault()
      return
    case 'd':
      void s.openDaily()
      return
    case 'I':
    case 'i':
      // Shift+I: the Bio star (fly to it, or offer to make it). Shift decides, as for Shift+G.
      if (e.shiftKey) {
        s.goToBio()
        return
      }
      // Import AI chats: the system file dialog (the key press is the gesture it needs).
      if (s.adapter && !s.adapter.readOnly) importChatsFromDialog()
      return
    case 'f':
      if (s.selectedId) s.controller.flyTo(s.selectedId)
      return
    case 'Home':
    case '0':
      s.controller.resetCamera()
      return
    case 'Tab':
      // Over the board / review, Tab moves focus between their controls.
      if (s.view === 'projects' || s.view === 'review' || s.view === 'capture' || s.view === 'boards') return
      e.preventDefault()
      // The Today hub's neighbors are its tasks: Tab walks into the brief (its rows keep Tab to themselves).
      if (s.selectedId !== null && isTodayId(s.selectedId) && focusBrief(e.shiftKey)) return
      s.cycleNeighbor(e.shiftKey ? -1 : 1)
      return
    case 't':
      s.toggleLayout()
      return
    case 'O':
    case 'o':
      // Shift+O: calm orbits (urgency never runs an orbit faster than a normal one). Shift decides, as for Shift+G.
      if (e.shiftKey) s.toggleCalm()
      else s.toggleMotion()
      return
    case '[':
      s.setFolderDepth(s.settings.folderDepth - 1)
      return
    case ']':
      s.setFolderDepth(s.settings.folderDepth + 1)
      return
    case 'x':
      if (s.selectedId && isFolderId(s.selectedId)) s.toggleFolder(folderPathOf(s.selectedId))
      return
    case 'G':
    case 'g':
      // Shift+G: the star gallery (the selected star's pictures in 3D), or fold the open one. With
      // Caps Lock on, Shift+G arrives as 'g' and a plain g as 'G': Shift decides.
      if (e.shiftKey) {
        s.toggleGallery()
        return
      }
      break
    case 'H':
    case 'h':
      // Shift+H: leave the selected folder out of the brain (desktop). Shift decides, as for Shift+G.
      if (e.shiftKey) {
        if (s.selectedId && isFolderId(s.selectedId)) void s.hideFolder(folderPathOf(s.selectedId))
        return
      }
      break
    case 'M':
    case 'm':
      // Shift+M: sound on / off. m: colour mode. Shift decides, as for Shift+G.
      if (e.shiftKey) {
        s.toggleSound()
        return
      }
      s.cycleColorMode()
      return
    case 'S':
    case 's': {
      // Shift+S: open every sun, or close every one. s: the selected sun (or the sun of the selected body) one level further.
      if (e.shiftKey) {
        s.toggleAllSuns()
        return
      }
      const sun = sunTargetOf(s)
      if (sun) {
        s.cycleSun(sun)
        return
      }
      break
    }
    case 'z':
      s.cyclePictureSize()
      return
    case 'B':
      // Shift+B: the boards, like 8. (With Caps Lock on, Shift+B arrives as 'b': see below.)
      if (e.shiftKey) {
        s.openBoards()
        return
      }
      break
    case 'b':
      if (e.shiftKey) {
        s.openBoards()
        return
      }
      s.setSettings({ bloom: !s.settings.bloom })
      return
    case 'l':
      s.setSettings({ hubLabels: !s.settings.hubLabels })
      return
    case '?':
      s.setHelp(true)
      return
    case 'ArrowLeft':
      e.preventDefault()
      e.shiftKey ? cam?.truck(-12, 0) : cam?.orbit(-0.18, 0)
      return
    case 'ArrowRight':
      e.preventDefault()
      e.shiftKey ? cam?.truck(12, 0) : cam?.orbit(0.18, 0)
      return
    case 'ArrowUp':
      e.preventDefault()
      e.shiftKey ? cam?.truck(0, -12) : cam?.orbit(0, -0.12)
      return
    case 'ArrowDown':
      e.preventDefault()
      e.shiftKey ? cam?.truck(0, 12) : cam?.orbit(0, 0.12)
      return
    case '+':
    case '=':
      cam?.dolly(18)
      return
    case '-':
    case '_':
      cam?.dolly(-18)
      return
  }
  // A host key works with Caps Lock on too (a plain g arrives as 'G').
  const extra = extraKeys.get(e.key) ?? (e.shiftKey ? undefined : extraKeys.get(e.key.toLowerCase()))
  if (extra) {
    e.preventDefault()
    extra()
  }
}
