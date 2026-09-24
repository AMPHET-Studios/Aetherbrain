import type { AetherState } from './store'
import { MOD } from './util'

export interface Command {
  id: string
  title: string
  hint?: string
  keys?: string
  group: 'navigate' | 'note' | 'view' | 'vault'
  run: (s: AetherState) => unknown
  /** Hide from the palette when false. */
  when?: (s: AetherState) => boolean
}

/** Every keyboard path has a palette twin, and vice versa. */
export const COMMANDS: Command[] = [
  { id: 'capture', title: 'Quick capture → Inbox', keys: `${MOD}+N · c`, group: 'note', run: (s) => s.setView('capture') },
  { id: 'daily', title: "Open today's daily note", keys: 'd', group: 'note', run: (s) => s.openDaily() },
  {
    id: 'open-selected',
    title: 'Open selected note in editor',
    keys: 'e · Enter',
    group: 'note',
    when: (s) => !!s.selectedId,
    run: (s) => s.selectedId && s.openNote(s.selectedId, { fly: true }),
  },
  {
    id: 'close-editor',
    title: 'Close editor (saves)',
    keys: 'Esc',
    group: 'note',
    when: (s) => !!s.editorId,
    run: (s) => s.closeEditor(),
  },
  {
    id: 'move-projects',
    title: 'Move note → Projects',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => s.moveToArea((s.editorId ?? s.selectedId)!, 'projects'),
  },
  {
    id: 'move-areas',
    title: 'Move note → Areas',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => s.moveToArea((s.editorId ?? s.selectedId)!, 'areas'),
  },
  {
    id: 'move-resources',
    title: 'Move note → Resources',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => s.moveToArea((s.editorId ?? s.selectedId)!, 'resources'),
  },
  {
    id: 'move-archive',
    title: 'Move note → Archive',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => s.moveToArea((s.editorId ?? s.selectedId)!, 'archive'),
  },
  {
    id: 'status-evergreen',
    title: 'Set status → evergreen',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => s.patchFrontmatter((s.editorId ?? s.selectedId)!, { status: 'evergreen' }),
  },
  {
    id: 'status-seedling',
    title: 'Set status → seedling',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => s.patchFrontmatter((s.editorId ?? s.selectedId)!, { status: 'seedling' }),
  },
  {
    id: 'delete',
    title: 'Delete note…',
    group: 'note',
    when: (s) => !!(s.editorId ?? s.selectedId),
    run: (s) => {
      const id = (s.editorId ?? s.selectedId)!
      const n = s.notes.get(id)
      if (n && window.confirm(`Delete "${n.meta.title}"? This removes the file from the vault.`)) void s.deleteNote(id)
    },
  },

  { id: 'fly', title: 'Fly to selected neuron', keys: 'f', group: 'navigate', when: (s) => !!s.selectedId, run: (s) => s.selectedId && s.controller.flyTo(s.selectedId) },
  { id: 'home', title: 'Reset camera', keys: 'Home · 0', group: 'navigate', run: (s) => s.controller.resetCamera() },
  { id: 'neighbor-next', title: 'Cycle to next neighbor', keys: 'Tab', group: 'navigate', run: (s) => s.cycleNeighbor(1) },
  { id: 'back', title: 'Back in history', keys: 'Alt+←', group: 'navigate', run: (s) => s.goBack() },
  { id: 'forward', title: 'Forward in history', keys: 'Alt+→', group: 'navigate', run: (s) => s.goForward() },
  { id: 'deselect', title: 'Clear selection + filters', keys: 'Esc', group: 'navigate', run: (s) => (s.select(null), s.clearFilters()) },

  { id: 'view-graph', title: 'View: Graph', keys: '1', group: 'view', run: (s) => s.setView('graph') },
  { id: 'view-editor', title: 'View: Editor', keys: '2', group: 'view', run: (s) => s.setView('editor') },
  { id: 'view-capture', title: 'View: Capture', keys: '3', group: 'view', run: (s) => s.setView('capture') },
  { id: 'view-search', title: 'View: Search', keys: '4 · /', group: 'view', run: (s) => s.setPalette(true) },
  { id: 'view-review', title: 'View: Review', keys: '5 · r', group: 'view', run: (s) => s.setView('review') },
  { id: 'view-projects', title: 'View: Projects board (to-dos)', keys: '6 · p', group: 'view', run: (s) => s.setView('projects') },
  {
    id: 'new-project',
    title: 'New project…',
    group: 'note',
    run: (s) => {
      const name = window.prompt('Project name (becomes Projects/<name>.md):')
      if (name?.trim()) void s.createProject(name).then(() => s.setView('projects'))
    },
  },
  { id: 'layout', title: 'Toggle layout: constellation ↔ orbit (time)', keys: 't', group: 'view', run: (s) => s.toggleLayout() },
  { id: 'color', title: 'Cycle color mode: area → type → tag → age', keys: 'm', group: 'view', run: (s) => s.cycleColorMode() },
  { id: 'bloom', title: 'Toggle bloom', keys: 'b', group: 'view', run: (s) => s.setSettings({ bloom: !s.settings.bloom }) },
  { id: 'labels', title: 'Toggle hub labels', keys: 'l', group: 'view', run: (s) => s.setSettings({ hubLabels: !s.settings.hubLabels }) },
  { id: 'help', title: 'Keyboard shortcuts', keys: '?', group: 'view', run: (s) => s.setHelp(true) },

  { id: 'reload', title: 'Reload vault from disk', group: 'vault', run: (s) => s.reload() },
  { id: 'reheat', title: 'Re-run layout physics', group: 'vault', run: (s) => s.controller.engine.reheat(0.6) },
]

export function findCommands(query: string, s: AetherState): Command[] {
  const q = query.trim().toLowerCase()
  return COMMANDS.filter((c) => (!c.when || c.when(s)) && (!q || c.title.toLowerCase().includes(q) || c.id.includes(q)))
}
