/**
 * The companion link, brain side: while a viewer (the Unreal app) reads the
 * scene, publish what this window draws (companion-scene.ts) whenever it
 * changes, and where everything is, up to 10 times a second; select or open
 * what the viewer picks. Nothing is published while nobody reads.
 * See docs/UNREAL.md.
 */
import { isVirtualId } from '@aether/core'
import { registerCommands, useAether } from '@aether/ui'
import type { AetherBridge } from '../shared/ipc'
import { companionScene } from './companion-scene'
import { errorText, openPanel } from './panels'
import { ElectronVaultAdapter } from './vault/electron'

/** How often positions are sent while a viewer reads (ms). */
export const COMPANION_TICK_MS = 100

let timer: ReturnType<typeof setInterval> | null = null
let version = 0
/** What the last published scene was made from: a new graph, colours or selection publish again. */
let made: unknown[] = []
let sentFrame = -1
let sentRings = -1

function tick(bridge: AetherBridge): void {
  const s = useAether.getState()
  const c = s.controller
  const g = c.graph
  if (!g || s.status !== 'ready') return
  const key = [g, c.colorMode, c.activeTag, s.selectedId, c.layoutMode, s.adapter, c.pictureSize]
  if (key.some((k, i) => k !== made[i])) {
    made = key
    version++
    bridge.companionGraph(
      companionScene(g, {
        version,
        vault: s.adapter?.name ?? 'Vault',
        layout: c.layoutMode,
        colorMode: c.colorMode,
        activeTag: c.activeTag,
        selectedId: s.selectedId,
        pictureSize: c.pictureSize,
      }),
    )
    sentFrame = -1
  }
  const eng = c.engine
  // Mid-rebuild the positions may still be the previous node set's.
  if (eng.positions.length !== g.nodes.length * 3) return
  if (eng.frame === sentFrame && eng.ringsVersion === sentRings) return
  sentFrame = eng.frame
  sentRings = eng.ringsVersion
  bridge.companionPositions(version, eng.positions, eng.rings)
}

function want(bridge: AetherBridge, on: boolean): void {
  if (timer) clearInterval(timer)
  timer = null
  // A viewer coming (back) gets everything again.
  made = []
  sentFrame = -1
  if (!on) return
  tick(bridge)
  timer = setInterval(() => tick(bridge), COMPANION_TICK_MS)
}

async function toggle(bridge: AetherBridge): Promise<void> {
  const s = useAether.getState()
  try {
    const st = await bridge.companionStatus()
    const next = await bridge.companionConfigure({ enabled: !st.enabled })
    if (next.error) s.toast(`Unreal companion link: ${next.error}`, 'error')
    else if (next.running) s.toast(`Unreal companion link on (port ${next.port}): open the Aether Brain Unreal app`, 'success')
    else s.toast('Unreal companion link off')
  } catch (err) {
    s.toast(`Unreal companion link: ${errorText(err)}`, 'error')
  }
}

const bridge = ElectronVaultAdapter.bridge()
if (bridge) {
  bridge.onCompanionWant((on) => want(bridge, on === true))
  bridge.onCompanionSelect((req) => {
    const s = useAether.getState()
    if (typeof req?.id !== 'string' || !s.graph?.index.has(req.id)) return
    // A viewer only looks: "open" opens a note that exists. Opening a ghost would write it, a folder would
    // expand, a picture would start another program; those are selected instead.
    if (req.open === true && !isVirtualId(req.id)) s.openNote(req.id, { fly: true })
    else s.select(req.id, { fly: true })
  })
  registerCommands([
    { id: 'companion-toggle', title: 'Unreal companion link: on / off', group: 'vault', run: () => toggle(bridge) },
    { id: 'companion-panel', title: 'Unreal companion link: status…', keys: 'a', group: 'vault', run: () => openPanel('ai') },
  ])
}
