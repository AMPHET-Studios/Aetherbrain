/**
 * The Concept Forge link, brain side: `g` opens the Forge window (the user's
 * concept-forge.html in a window of its own), and this window's store serves
 * the Forge window's requests that main relays here: the project list for its
 * picker, and saving a graded drawing into a project's Critique planet (the
 * store toasts here; the Forge window shows its own confirmation).
 *
 * The Concept Forge star: the project star that carries the Forge (see
 * forge-star.ts) gets a live screen of the page that grows out of it when the
 * camera comes close (main sends the frames while it is in view); Enter or a
 * click on it opens the Forge window to draw. See docs/FORGE-LINK.md.
 */
import { useSyncExternalStore } from 'react'
import { isProjectNote, type NoteId } from '@aether/core'
import type { ScreenHost } from '@aether/graph'
import { registerCommands, registerHelpRows, registerKey, useAether } from '@aether/ui'
import type { AetherBridge, ForgeRequest, ForgeStatus } from '../shared/ipc'
import { forgeDirOf, forgeStar, isForgeName, projectStars } from './forge-star'
import { errorText } from './panels'
import { ElectronVaultAdapter } from './vault/electron'

/** Said once per run, the first time the Forge window opens. */
let hinted = false

async function openForge(bridge: AetherBridge, pick: boolean): Promise<void> {
  const s = useAether.getState()
  try {
    const status = await bridge.forgeOpen(pick ? { pick: true } : undefined)
    forgeStatus(bridge, status)
    // A cancelled file dialog changes nothing and needs no word.
    if (!status.open || hinted) return
    hinted = true
    s.toast('Concept Forge is open: its 🪐 Save to Brain button (Ctrl+Shift+B) files a drawing into a project’s Critique planet', 'info')
  } catch (err) {
    s.toast(`Concept Forge: ${errorText(err)}`, 'error')
  }
}

/** One relayed request, served by the store (a rejection reaches the Forge window as its message). */
function serve(req: ForgeRequest): Promise<unknown> {
  const s = useAether.getState()
  if (req.kind === 'save') return s.saveCritique(req.save)
  // Refused the way the store refuses a save: an empty list before the vault is in would read as "no projects yet, make one".
  if (s.status === 'loading') return Promise.reject(new Error('The vault is still loading; try again in a moment'))
  if (s.status !== 'ready') return Promise.reject(new Error('Open your vault in Aether Brain first'))
  return Promise.resolve(s.forgeProjects())
}

/* ------------------------------------------------------------------ */
/* The Concept Forge star                                             */
/* ------------------------------------------------------------------ */

/** The remembered concept-forge.html (null before the first pick), as main last said. */
let forgeFile: string | null = null
/** The star screen is in view (the hint under it says Enter draws). */
let screenShown = false
const screenSubs = new Set<() => void>()
let starHost: ScreenHost | null = null

function setShown(on: boolean): void {
  if (on === screenShown) return
  screenShown = on
  for (const cb of screenSubs) cb()
}

/** True while the Concept Forge star's screen is in view (for the hint chip). */
export function useForgeScreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      screenSubs.add(cb)
      return () => void screenSubs.delete(cb)
    },
    () => screenShown,
  )
}

/** What main said about the Forge: the screen's words follow the remembered file. */
function forgeStatus(bridge: AetherBridge, status: ForgeStatus): void {
  if (status.file === forgeFile) return
  forgeFile = status.file
  syncStar(bridge)
}

/** The star that carries the Concept Forge now, or null. */
function currentStar(platform: string): NoteId | null {
  const s = useAether.getState()
  if (s.status !== 'ready') return null
  const roots = s.adapter instanceof ElectronVaultAdapter ? s.adapter.roots : []
  return forgeStar(projectStars(s.notes.values(), s.folders), forgeDirOf(forgeFile, roots, platform), platform)
}

/** Put the screen on the star that carries the Forge (or take it away when none does). */
function syncStar(bridge: AetherBridge): void {
  const { controller } = useAether.getState()
  const star = currentStar(bridge.platform)
  if (!star) {
    controller.setScreen(null)
    return
  }
  starHost ??= {
    want: (on) => {
      setShown(on)
      bridge.forgeScreen(on).catch(() => undefined)
    },
    activate: () => void openForge(bridge, false),
  }
  controller.setScreen({
    star,
    host: starHost,
    placeholder: forgeFile ? 'Concept Forge is waking up…' : 'Press g to choose your concept-forge.html',
  })
}

/**
 * Palette: fly to the Concept Forge star. Without one, the project note called
 * Concept Forge gets its home folder (the star), or a new project is made.
 */
async function flyToStar(bridge: AetherBridge): Promise<void> {
  const s = useAether.getState()
  if (s.status !== 'ready') {
    s.toast('Open your vault first', 'info')
    return
  }
  const star = currentStar(bridge.platform)
  if (star) {
    s.showFolder(star.slice('folder:'.length))
    return
  }
  try {
    let note = [...s.notes.values()].find((n) => isProjectNote(n) && [n.meta.title, ...n.meta.aliases].some(isForgeName))
    if (!note) {
      const id = await s.createProject('Concept Forge', 'My concept-art trainer: timed drills, grades and critiques. Its ★ star shows the page live.')
      note = id ? useAether.getState().notes.get(id) : undefined
      if (!note) return
    }
    const home = await useAether.getState().createFolder(note.meta.path.replace(/\.md$/i, ''))
    if (!home) return
    syncStar(bridge)
    useAether.getState().showFolder(home)
  } catch (err) {
    useAether.getState().toast(`Concept Forge star: ${errorText(err)}`, 'error')
  }
}

const bridge = ElectronVaultAdapter.bridge()
if (bridge) {
  registerKey('g', () => void openForge(bridge, false))
  registerCommands([
    { id: 'forge-open', title: 'Concept Forge — open', keys: 'g', group: 'vault', run: () => openForge(bridge, false) },
    { id: 'forge-pick', title: 'Concept Forge — choose file…', group: 'vault', run: () => openForge(bridge, true) },
    { id: 'forge-star', title: 'Concept Forge — fly to its star (live screen)', group: 'vault', run: () => flyToStar(bridge) },
  ])
  registerHelpRows('Desktop', [
    ['g', 'Concept Forge: draw, grade, save the drawing to a project'],
    ['Enter', 'At the Concept Forge star: open its live screen to draw'],
  ])
  bridge.onForgeRequest(serve)
  bridge.onForgeFrame((f) => useAether.getState().controller.pushScreenFrame({ data: f.data, width: f.width, height: f.height, bgra: f.bgra }))
  useAether.subscribe((st, prev) => {
    if (st.notes !== prev.notes || st.folders !== prev.folders || st.status !== prev.status || st.adapter !== prev.adapter) syncStar(bridge)
  })
  bridge.forgeStatus().then(
    (status) => forgeStatus(bridge, status),
    () => undefined,
  )
}
