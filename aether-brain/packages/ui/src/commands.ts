import { folderPathOf, imageFileName, imagePathOf, isFolderId, isImageId, isImagePath, isSunNode, type NoteId } from '@aether/core'
import { PICTURE_SIZES, PICTURE_SIZE_NAMES } from '@aether/graph'
import { getActiveBoard } from './board/active'
import { BOARD_COMMANDS } from './board/commands'
import { importChatsFromDialog } from './components/chats'
import { copyEmbed, importPicturesFromDialog } from './components/pictures'
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

/** The note a note command acts on: the open note, else the selection when it is a note (not a folder or ghost). */
export function noteTarget(s: AetherState): NoteId | null {
  if (s.editorId) return s.editorId
  return s.selectedId && s.notes.has(s.selectedId) ? s.selectedId : null
}

/** The sun the selection is, or belongs to (a body's folder, a picture's board), or null: what `s` opens a level further. */
export function sunTargetOf(s: AetherState): NoteId | null {
  const g = s.graph
  if (!g || !s.selectedId || s.settings.layoutMode !== 'system' || !s.settings.suns) return null
  const node = g.nodes[g.index.get(s.selectedId) ?? -1]
  if (!node) return null
  if (isSunNode(node)) return node.id
  const parent = node.parent ? g.nodes[g.index.get(node.parent) ?? -1] : undefined
  return parent && isSunNode(parent) ? parent.id : null
}

/** Vault path of the selected folder node, or null when the selection is not a folder. */
export function selectedFolder(s: AetherState): string | null {
  return s.selectedId && isFolderId(s.selectedId) ? folderPathOf(s.selectedId) : null
}

/** Vault path of the selected picture, or null when the selection is not a picture. */
export function selectedImage(s: AetherState): string | null {
  return s.selectedId && isImageId(s.selectedId) ? imagePathOf(s.selectedId) : null
}

/** Vault path of the selected picture when a board can take it (a video or a 3D model is shown in the brain, never put on a board), else null. */
function selectedBoardPicture(s: AetherState): string | null {
  const path = selectedImage(s)
  return path !== null && isImagePath(path) ? path : null
}

/** The selected folder when it is a folder on disk (not the vault root that joins several drives). */
function diskFolder(s: AetherState): string | null {
  const f = selectedFolder(s)
  return f === '' && s.roots.length > 1 ? null : f
}

/** The project note of the selected folder when that folder is a project star, else null. */
export function selectedProject(s: AetherState): NoteId | null {
  if (!s.selectedId || !isFolderId(s.selectedId)) return null
  const id = s.graph?.nodes[s.graph.index.get(s.selectedId) ?? -1]?.folder?.projectId ?? null
  return id && s.notes.has(id) ? id : null
}

const writable = (s: AetherState) => !!s.adapter && !s.adapter.readOnly

/**
 * Every command of the board that is open, as a palette entry "Board: …" (the table is board/commands.ts, which also holds the keys).
 * Offered while a board is open in the Boards view and enough items are selected for the command. The window rows (pop out, dock, on
 * top) are the desktop app's (`renderer/board.ts` registers them with the right state), so they are not repeated here; "show in the file
 * manager" needs a vault that can.
 */
export const BOARD_PALETTE: Command[] = BOARD_COMMANDS.filter((c) => !c.id.startsWith('window.')).map((c) => ({
  id: `board-${c.id}`,
  title: `Board: ${c.title}`,
  group: 'view' as const,
  ...(c.keys ? { keys: c.keys } : {}),
  when: (s: AetherState) => {
    const board = getActiveBoard()
    if (!board || s.view !== 'boards') return false
    if (c.id === 'picture.reveal' && !s.adapter?.reveal) return false
    return board.state().selection.length >= (c.needs ?? 0)
  },
  run: () => getActiveBoard()?.exec(c.id),
}))

/** The board a picture command acts on: the one open, else the one last open (null: none). */
const targetBoard = (s: AetherState): string | null => s.boardPath ?? s.lastBoardPath

/** Every keyboard path has a palette twin, and vice versa. */
export const COMMANDS: Command[] = [
  { id: 'capture', title: 'Quick capture → Inbox', keys: `${MOD}+N · c`, group: 'note', run: (s) => s.setView('capture') },
  { id: 'today', title: 'Today — daily brief', keys: 'y · 7', group: 'navigate', run: (s) => s.showToday() },
  { id: 'daily', title: "Open today's daily note", keys: 'd', group: 'note', run: (s) => s.openDaily() },
  {
    id: 'bio-go',
    title: 'Bio star — fly to it',
    hint: 'sleep, food, meds, exercise, drugs, mental health',
    keys: '⇧ I',
    group: 'navigate',
    run: (s) => s.goToBio(),
  },
  {
    id: 'bio-make',
    title: 'Create my Bio star (sleep, food, meds, exercise, drugs, mental health)',
    hint: 'a big blue star with a page for each; nothing already there is touched',
    group: 'vault',
    when: writable,
    run: (s) => s.makeBio(),
  },
  {
    id: 'open-selected',
    title: 'Open selected note in editor',
    keys: 'e · Enter',
    group: 'note',
    when: (s) => !!s.selectedId && s.notes.has(s.selectedId),
    run: (s) => s.selectedId && s.openNote(s.selectedId, { fly: true }),
  },
  {
    id: 'picture-open',
    title: 'Open the selected picture in your image app',
    keys: 'e · Enter',
    group: 'note',
    when: (s) => selectedImage(s) !== null,
    run: (s) => s.openImage(selectedImage(s)!),
  },
  {
    id: 'picture-embed',
    title: 'Copy the embed of the selected picture (![[…]])',
    group: 'note',
    when: (s) => selectedImage(s) !== null,
    run: (s) => copyEmbed(selectedImage(s)!),
  },
  {
    id: 'import-pictures',
    title: 'Import pictures…',
    group: 'vault',
    when: (s) => writable(s) && !!s.adapter?.createAsset,
    run: () => importPicturesFromDialog(),
  },
  {
    id: 'import-chats',
    title: 'Import AI chats (Claude / ChatGPT export)…',
    hint: 'the data export zip, or its conversations.json',
    keys: 'i',
    group: 'vault',
    when: (s) => writable(s),
    run: () => importChatsFromDialog(),
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
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => s.moveToArea(noteTarget(s)!, 'projects'),
  },
  {
    id: 'move-areas',
    title: 'Move note → Areas',
    group: 'note',
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => s.moveToArea(noteTarget(s)!, 'areas'),
  },
  {
    id: 'move-resources',
    title: 'Move note → Resources',
    group: 'note',
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => s.moveToArea(noteTarget(s)!, 'resources'),
  },
  {
    id: 'move-archive',
    title: 'Move note → Archive',
    group: 'note',
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => s.moveToArea(noteTarget(s)!, 'archive'),
  },
  {
    id: 'status-evergreen',
    title: 'Set status → evergreen',
    group: 'note',
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => s.patchFrontmatter(noteTarget(s)!, { status: 'evergreen' }),
  },
  {
    id: 'status-seedling',
    title: 'Set status → seedling',
    group: 'note',
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => s.patchFrontmatter(noteTarget(s)!, { status: 'seedling' }),
  },
  {
    id: 'delete',
    title: 'Delete note…',
    group: 'note',
    when: (s) => writable(s) && !!noteTarget(s),
    run: (s) => {
      const id = noteTarget(s)!
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
  { id: 'boards-open', title: 'Boards: open', hint: 'the board you were on, else the list', keys: '8 · ⇧ B', group: 'view', run: (s) => s.openBoards() },
  {
    id: 'boards-list',
    title: 'Boards: show list',
    group: 'view',
    run: (s) => {
      s.closeBoard()
      s.setView('boards')
    },
  },
  { id: 'boards-new', title: 'Boards: new board', hint: 'a canvas for pictures, notes and sketches (n in the list)', group: 'view', when: writable, run: (s) => s.requestForm('board') },
  {
    id: 'boards-open-selected',
    title: 'Boards: open the selected note as a board',
    group: 'view',
    when: (s) => !!s.selectedId && !!s.notes.get(s.selectedId) && s.notes.get(s.selectedId)!.frontmatter['type'] === 'board',
    run: (s) => s.selectedId && s.openBoard(s.notes.get(s.selectedId)!.meta.path),
  },
  {
    id: 'boards-add-picture',
    title: 'Boards: add the selected picture to the last board',
    hint: 'the board open or last open',
    group: 'view',
    when: (s) => writable(s) && selectedBoardPicture(s) !== null && targetBoard(s) !== null,
    run: (s) => s.addPicturesToBoard([selectedBoardPicture(s)!]),
  },
  {
    id: 'boards-add-picture-new',
    title: 'Boards: add the selected picture to a new board',
    group: 'view',
    when: (s) => writable(s) && selectedBoardPicture(s) !== null,
    run: async (s) => {
      const path = selectedBoardPicture(s)!
      const board = await s.newBoard(`${imageFileName(path).replace(/\.[^.]+$/, '')} reference`, { open: false })
      if (board) await s.addPicturesToBoard([path], board)
    },
  },
  ...BOARD_PALETTE,
  {
    id: 'new-project',
    title: 'New project…',
    group: 'note',
    when: writable,
    run: (s) => s.requestForm('project'),
  },
  { id: 'layout', title: 'Cycle layout: constellation → orbit (time) → system (folders)', keys: 't', group: 'view', run: (s) => s.toggleLayout() },
  { id: 'motion', title: 'System layout: orbits moving / paused', keys: 'o', group: 'view', run: (s) => s.toggleMotion() },
  {
    id: 'calm',
    title: 'System layout: calm orbits on / off',
    hint: 'urgency speeds an orbit up less: none runs faster than a normal one',
    keys: 'Shift+O',
    group: 'view',
    run: (s) => s.toggleCalm(),
  },
  {
    id: 'sun-next',
    title: 'Sun: show the next level (closed → planets → planets and moons)',
    hint: 'a click on a closed sun opens its planets; the bar at the bottom picks a level',
    keys: 's',
    group: 'view',
    when: (s) => sunTargetOf(s) !== null,
    run: (s) => s.cycleSun(sunTargetOf(s)!),
  },
  {
    id: 'suns-all',
    title: 'Suns: open every one, or close every one',
    keys: 'Shift+S',
    group: 'view',
    run: (s) => s.toggleAllSuns(),
  },
  {
    id: 'suns-setting',
    title: 'Suns: open on click / always show every planet and moon',
    group: 'view',
    run: (s) => s.toggleSuns(),
  },
  {
    id: 'sound',
    title: 'Sound: a note for every click on / off',
    hint: 'a note for each star, planet and moon you click, a run when a sun opens',
    keys: 'Shift+M',
    group: 'view',
    run: (s) => s.toggleSound(),
  },
  { id: 'depth-less', title: 'System layout: show fewer folder levels', keys: '[', group: 'view', run: (s) => s.setFolderDepth(s.settings.folderDepth - 1) },
  { id: 'depth-more', title: 'System layout: show more folder levels', keys: ']', group: 'view', run: (s) => s.setFolderDepth(s.settings.folderDepth + 1) },
  {
    id: 'folder-toggle',
    title: 'Expand / collapse selected folder',
    keys: 'x',
    group: 'view',
    when: (s) => selectedFolder(s) !== null,
    run: (s) => s.toggleFolder(selectedFolder(s)!),
  },
  {
    id: 'folder-new',
    title: 'New folder (planet) inside the selected folder…',
    group: 'vault',
    when: (s) => diskFolder(s) !== null && writable(s) && !!s.adapter?.createFolder,
    run: (s) => s.requestForm('folder'),
  },
  {
    id: 'folder-note',
    title: 'New note in the selected folder…',
    group: 'note',
    when: (s) => diskFolder(s) !== null && writable(s),
    run: (s) => s.requestForm('note'),
  },
  {
    id: 'folder-project',
    title: 'Make the selected folder a project (star)',
    group: 'note',
    when: (s) => {
      const f = selectedFolder(s)
      const info = s.selectedId ? s.graph?.nodes[s.graph.index.get(s.selectedId) ?? -1]?.folder : undefined
      return !!f && writable(s) && info?.role === 'folder'
    },
    run: (s) => s.makeProject(selectedFolder(s)!),
  },
  {
    id: 'folder-board',
    title: "Open the selected star's project board",
    keys: 'p',
    group: 'view',
    when: (s) => selectedProject(s) !== null,
    run: (s) => {
      s.selectProject(selectedProject(s))
      s.setView('projects')
    },
  },
  {
    id: 'reveal',
    title: 'Show in the file manager',
    group: 'vault',
    when: (s) => !!s.adapter?.reveal && (selectedFolder(s) !== null || selectedImage(s) !== null || !!noteTarget(s)),
    run: (s) => {
      const note = noteTarget(s)
      const path = selectedFolder(s) ?? selectedImage(s) ?? (note ? s.notes.get(note)?.meta.path : undefined)
      if (path !== undefined) void s.reveal(path)
    },
  },
  {
    id: 'hide-folder',
    title: 'Leave the selected folder out of the brain (nothing on disk changes)',
    keys: 'Shift+H',
    group: 'vault',
    when: (s) => {
      const f = diskFolder(s)
      // Not the vault's top folder, nor a whole root of a multi-root vault (those are removed in Vault folders).
      return !!s.adapter?.hideFolder && !!f && !(s.roots.length > 1 && !f.includes('/'))
    },
    run: (s) => {
      const f = diskFolder(s)
      if (f) void s.hideFolder(f)
    },
  },
  {
    id: 'gallery',
    title: "Star gallery: the selected star's pictures in 3D (again: fold them)",
    keys: 'Shift+G',
    group: 'view',
    when: (s) => s.settings.layoutMode === 'system',
    run: (s) => s.toggleGallery(),
  },
  {
    id: 'star-galleries',
    title: 'Toggle star galleries (open as you fly close to a star)',
    group: 'view',
    run: (s) => {
      const on = !s.settings.starGalleries
      s.setSettings({ starGalleries: on })
      s.toast(on ? 'Star galleries on: fly close to a ★ star to see its pictures in 3D' : 'Star galleries off: Shift+G still opens one')
    },
  },
  { id: 'color', title: 'Cycle color mode: area → type → tag → age', keys: 'm', group: 'view', run: (s) => s.cycleColorMode() },
  { id: 'bloom', title: 'Toggle bloom', keys: 'b', group: 'view', run: (s) => s.setSettings({ bloom: !s.settings.bloom }) },
  { id: 'labels', title: 'Toggle hub labels', keys: 'l', group: 'view', run: (s) => s.setSettings({ hubLabels: !s.settings.hubLabels }) },
  {
    id: 'today-hub',
    title: 'Toggle Today hub',
    group: 'view',
    run: (s) => {
      const on = !s.settings.todayHub
      s.setSettings({ todayHub: on })
      s.toast(on ? 'Today hub on — y flies to it' : 'Today hub off')
    },
  },
  {
    id: 'picture-moons',
    title: 'Toggle image moons',
    group: 'view',
    run: (s) => {
      const on = !s.settings.imageMoons
      s.setSettings({ imageMoons: on })
      s.toast(on ? `Image moons on${s.settings.layoutMode === 'system' ? '' : ' — they orbit their folders in the system layout (t)'}` : 'Image moons off — embedded pictures stay')
    },
  },
  { id: 'picture-size', title: 'Picture size: medium → large → extra large icons', keys: 'z', group: 'view', run: (s) => s.cyclePictureSize() },
  ...PICTURE_SIZES.map((size) => ({
    id: `picture-size-${size}`,
    title: `Pictures: ${PICTURE_SIZE_NAMES[size].toLowerCase()}`,
    group: 'view' as const,
    run: (s: AetherState) => {
      s.setSettings({ pictureSize: size })
      s.toast(`Pictures: ${PICTURE_SIZE_NAMES[size].toLowerCase()}`)
    },
  })),
  {
    id: 'picture-thumbnails',
    title: 'Toggle picture thumbnails',
    group: 'view',
    run: (s) => {
      const on = !s.settings.thumbnails
      s.setSettings({ thumbnails: on })
      s.toast(on ? 'Picture thumbnails on' : 'Picture thumbnails off — pictures are plain moons')
    },
  },
  { id: 'help', title: 'Keyboard shortcuts', keys: '?', group: 'view', run: (s) => s.setHelp(true) },

  { id: 'reload', title: 'Reload vault from disk', group: 'vault', run: (s) => s.reload() },
  { id: 'reheat', title: 'Re-run layout physics', group: 'vault', run: (s) => s.controller.engine.reheat(0.6) },
]

/** Commands added by the host app (e.g. the desktop's vault-folders and AI-link panels). */
const extra: Command[] = []

/**
 * Add palette entries from outside the package (desktop-only UI). A command
 * with the id of an earlier registration replaces it; built-in ids win.
 */
export function registerCommands(cmds: Command[]): void {
  for (const c of cmds) {
    if (COMMANDS.some((b) => b.id === c.id)) continue
    const i = extra.findIndex((e) => e.id === c.id)
    if (i >= 0) extra[i] = c
    else extra.push(c)
  }
}

export function findCommands(query: string, s: AetherState): Command[] {
  const q = query.trim().toLowerCase()
  return [...COMMANDS, ...extra].filter((c) => (!c.when || c.when(s)) && (!q || c.title.toLowerCase().includes(q) || c.id.includes(q)))
}
