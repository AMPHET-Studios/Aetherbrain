/**
 * The Concept Forge link, brain side: `g` opens the Forge window (the user's
 * concept-forge.html in a window of its own), and this window's store serves
 * the Forge window's requests that main relays here: the project list for its
 * picker, and saving a graded drawing into a project's Critique planet (the
 * store toasts here; the Forge window shows its own confirmation).
 * See docs/FORGE-LINK.md.
 */
import { registerCommands, registerHelpRows, registerKey, useAether } from '@aether/ui'
import type { AetherBridge, ForgeRequest } from '../shared/ipc'
import { errorText } from './panels'
import { ElectronVaultAdapter } from './vault/electron'

/** Said once per run, the first time the Forge window opens. */
let hinted = false

async function openForge(bridge: AetherBridge, pick: boolean): Promise<void> {
  const s = useAether.getState()
  try {
    const status = await bridge.forgeOpen(pick ? { pick: true } : undefined)
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
  if (req.kind === 'projects') return Promise.resolve(s.forgeProjects())
  return s.saveCritique(req.save)
}

const bridge = ElectronVaultAdapter.bridge()
if (bridge) {
  registerKey('g', () => void openForge(bridge, false))
  registerCommands([
    { id: 'forge-open', title: 'Concept Forge — open', keys: 'g', group: 'vault', run: () => openForge(bridge, false) },
    { id: 'forge-pick', title: 'Concept Forge — choose file…', group: 'vault', run: () => openForge(bridge, true) },
  ])
  registerHelpRows('Desktop', [['g', 'Concept Forge: draw, grade, save the drawing to a project']])
  bridge.onForgeRequest(serve)
}
