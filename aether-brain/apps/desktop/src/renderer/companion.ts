/**
 * The companion link, brain side: while a viewer (the Unreal app) reads the
 * scene, publish what this window draws (companion-scene.ts, cut to a budget
 * by companion-bound.ts) whenever it changes, and where everything is, up to
 * 10 times a second; select or open what the viewer picks. Nothing is
 * published while nobody reads. See docs/UNREAL.md.
 */
import { isVirtualId } from '@aether/core'
import { registerCommands, useAether } from '@aether/ui'
import type { AetherBridge } from '../shared/ipc'
import { CompanionFeed, type FeedSource } from './companion-feed'
import { errorText, openPanel } from './panels'
import { ElectronVaultAdapter } from './vault/electron'

/** How often positions are sent while a viewer reads (ms). */
export const COMPANION_TICK_MS = 100

let timer: ReturnType<typeof setInterval> | null = null
let feed: CompanionFeed | null = null

/** What the brain window shows now, or null while it shows nothing. */
function source(): FeedSource | null {
  const s = useAether.getState()
  const c = s.controller
  const g = c.graph
  if (!g || s.status !== 'ready') return null
  return {
    graph: g,
    engine: c.engine,
    vault: s.adapter?.name ?? 'Vault',
    adapter: s.adapter,
    selectedId: s.selectedId,
    colorMode: c.colorMode,
    activeTag: c.activeTag,
    layoutMode: c.layoutMode,
    pictureSize: c.pictureSize,
  }
}

function want(bridge: AetherBridge, on: boolean): void {
  feed ??= new CompanionFeed(source, bridge)
  // The main process keeps this window running at full speed while a viewer reads (a covered window would be slowed
  // down, and the scene would stop reaching the viewer); the 3D view does not need to be drawn behind the viewer.
  useAether.getState().controller.setRestBehind(on)
  if (on && timer) {
    // The link asking a window that is already publishing (nothing was published for a few seconds: a layout that
    // stands still sends no frames). Send the places again; the scene is the same, and a viewer that has it must not
    // be handed the whole of it under a new version.
    feed.resend()
    feed.tick()
    return
  }
  if (timer) clearInterval(timer)
  timer = null
  if (!on) {
    // Nobody reads: let go of what was held for them.
    feed.stop()
    return
  }
  // A viewer coming (back) gets everything again.
  feed.restart()
  feed.tick()
  timer = setInterval(() => feed?.tick(), COMPANION_TICK_MS)
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
