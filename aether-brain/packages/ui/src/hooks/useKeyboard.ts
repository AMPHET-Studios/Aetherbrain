import { useEffect } from 'react'
import { useAether } from '../store'
import { isTyping } from '../util'

/**
 * Global keyboard map. Text fields keep their keys; everything else is
 * single-key so the graph can be driven without a mouse.
 * See docs/KEYBOARD.md.
 */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
        if (s.view === 'capture' || s.view === 'review') return s.setView('graph')
        if (s.editorId && s.view === 'editor') return s.closeEditor()
        if (isTyping(e)) {
          ;(e.target as HTMLElement).blur()
          return
        }
        if (s.editorId) return s.closeEditor()
        if (s.filters.query || s.filters.areas.size || s.filters.tags.size || s.filters.types.size) return s.clearFilters()
        if (s.selectedId) return s.select(null)
        return
      }

      if (isTyping(e) || mod || e.altKey) return
      if (s.paletteOpen || s.helpOpen) return

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
          else if (s.selectedId) s.openNote(s.selectedId, { fly: true })
          return
        case '5':
        case 'r':
          s.setView('review')
          return
        case 'e':
        case 'Enter':
          if (s.selectedId) s.openNote(s.selectedId, { fly: true })
          return
        case 'd':
          void s.openDaily()
          return
        case 'f':
          if (s.selectedId) s.controller.flyTo(s.selectedId)
          return
        case 'Home':
        case '0':
          s.controller.resetCamera()
          return
        case 'Tab':
          e.preventDefault()
          s.cycleNeighbor(e.shiftKey ? -1 : 1)
          return
        case 't':
          s.toggleLayout()
          return
        case 'm':
          s.cycleColorMode()
          return
        case 'b':
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
