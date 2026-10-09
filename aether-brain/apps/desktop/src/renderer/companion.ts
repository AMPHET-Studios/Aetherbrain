/**
 * The companion link, brain side: while a viewer (the Unreal app) reads the
 * scene, publish what this window draws (companion-scene.ts, cut to a budget
 * by companion-bound.ts) whenever it changes, and where everything is, up to
 * 10 times a second; select or open what the viewer picks. Nothing is
 * published while nobody reads. See docs/UNREAL.md.
 */
import { isVirtualId, type GraphData } from '@aether/core'
import { registerCommands, useAether } from '@aether/ui'
import type { AetherBridge } from '../shared/ipc'
import { COMPANION_BUDGET, boundRings, gatherPositions, planBase, planFor, type BasePlan, type ScenePlan } from './companion-bound'
import { companionScene } from './companion-scene'
import { errorText, openPanel } from './panels'
import { ElectronVaultAdapter } from './vault/electron'

/** How often positions are sent while a viewer reads (ms). */
export const COMPANION_TICK_MS = 100
/** The bounded rings are worked out again for this many position frames after the layout (or the plan) changes: the first frame may still be the old layout's. */
const RING_SETTLE_FRAMES = 3

let timer: ReturnType<typeof setInterval> | null = null
let version = 0
/** What the last published scene was made from: a new graph, colours or selection publish again. */
let made: unknown[] = []
let sentFrame = -1
let sentRings = -1
/** What to send of the graph in `made`, and what it was made from. */
let base: { graph: GraphData; plan: BasePlan } | null = null
let plan: ScenePlan | null = null
let ringsOut: Float32Array = new Float32Array(0)
let ringsFrom = -1
let ringsSettle = 0
let placed: Float32Array | null = null

function tick(bridge: AetherBridge): void {
  const s = useAether.getState()
  const c = s.controller
  const g = c.graph
  if (!g || s.status !== 'ready') return
  const key = [g, c.colorMode, c.activeTag, s.selectedId, c.layoutMode, s.adapter, c.pictureSize]
  if (key.some((k, i) => k !== made[i])) {
    made = key
    version++
    // Which part of a big brain the viewer gets: once per graph, and again for another selection.
    if (base?.graph !== g) base = { graph: g, plan: planBase(g, COMPANION_BUDGET) }
    plan = planFor(g, base.plan, s.selectedId, COMPANION_BUDGET)
    bridge.companionGraph(
      companionScene(
        g,
        {
          version,
          vault: s.adapter?.name ?? 'Vault',
          layout: c.layoutMode,
          colorMode: c.colorMode,
          activeTag: c.activeTag,
          selectedId: s.selectedId,
          pictureSize: c.pictureSize,
        },
        plan,
      ),
    )
    sentFrame = -1
    ringsFrom = -1
    ringsSettle = RING_SETTLE_FRAMES
  }
  const eng = c.engine
  // Until the layout worker has laid this node set out, the positions are a seed (zeros for a new vault): not the brain's places.
  if (!plan || !eng.placed) return
  // Mid-rebuild the positions may still be the previous node set's.
  if (eng.positions.length !== g.nodes.length * 3) return
  if (eng.frame === sentFrame && eng.ringsVersion === sentRings) return
  sentFrame = eng.frame
  if (eng.ringsVersion !== ringsFrom) {
    ringsFrom = eng.ringsVersion
    ringsSettle = RING_SETTLE_FRAMES
  }
  if (ringsSettle > 0) {
    ringsSettle--
    ringsOut = boundRings(g, plan, eng.rings, eng.positions, COMPANION_BUDGET.rings)
  }
  sentRings = eng.ringsVersion
  placed = gatherPositions(plan, eng.positions, placed ?? undefined)
  bridge.companionPositions(version, placed, ringsOut)
}

function want(bridge: AetherBridge, on: boolean): void {
  if (on && timer) {
    // The link asking a window that is already publishing (nothing was published for a few seconds: a layout that
    // stands still sends no frames). Send the places again; the scene is the same, and a viewer that has it must not
    // be handed the whole of it under a new version.
    sentFrame = -1
    sentRings = -1
    tick(bridge)
    return
  }
  if (timer) clearInterval(timer)
  timer = null
  // A viewer coming (back) gets everything again.
  made = []
  sentFrame = -1
  sentRings = -1
  if (!on) {
    base = null
    plan = null
    placed = null
    ringsOut = new Float32Array(0)
    return
  }
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
