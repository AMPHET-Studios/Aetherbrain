import { useMemo } from 'react'
import { SUN_LEVELS, SUN_LEVEL_NAMES, isSunNode, type SunLevel } from '@aether/core'
import { useAether } from '../store'
import { cx } from '../util'

/**
 * The control on a sun: while a sun (a folder's star, a galaxy, a reference board with pictures) is selected, a bar at the bottom of
 * the 3D view says how open it is and lets the user choose: closed (only the body and what is urgent), the folders under it (a star's planets, a planet's moons), or those
 * and its files (its satellites). A click on a closed sun opens its folders; `s` steps through the same levels.
 */
export function SunDial() {
  const selectedId = useAether((s) => s.selectedId)
  const graph = useAether((s) => s.graph)
  const layoutMode = useAether((s) => s.settings.layoutMode)
  const suns = useAether((s) => s.settings.suns)
  const level = useAether((s) => (selectedId ? (s.sunOwn[selectedId] ?? s.sunDefault) : 0))
  const chooseSun = useAether((s) => s.chooseSun)
  const node = graph && selectedId ? graph.nodes[graph.index.get(selectedId) ?? -1] : undefined
  // One count per graph and sun: the store keeps it, this only asks again when the graph or the selection changes.
  const counts = useMemo(() => (graph && selectedId ? useAether.getState().sunCountsOf(selectedId) : null), [graph, selectedId])
  if (!node || !isSunNode(node) || layoutMode !== 'system' || !suns || !counts) return null
  const has: Record<SunLevel, boolean> = { 0: true, 1: counts.planets + counts.systems > 0, 2: counts.moons > 0 }
  const nothing = counts.planets + counts.systems + counts.moons === 0
  const parts = [
    counts.planets > 0 ? `${counts.planets} board${counts.planets === 1 ? '' : 's'}` : '',
    counts.systems > 0 ? `${counts.systems} folder${counts.systems === 1 ? '' : 's'}` : '',
    counts.moons > 0 ? `${counts.moons} file${counts.moons === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return (
    <div className="panel flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[11.5px]" role="group" aria-label={`How open ${node.title} is`}>
      <span className="text-dim">
        <span className="text-ink">☀ {node.title}</span>
        {nothing ? ' · nothing to open' : ` · ${parts.join(' · ')}`}
      </span>
      {!nothing && (
        <span className="flex items-center gap-1.5">
          {SUN_LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className={cx('chip', level === l && 'active')}
              aria-pressed={level === l}
              disabled={!has[l]}
              onClick={() => chooseSun(node.id, l)}
              title={l === 0 ? 'Close it: only the body shows (s steps through the levels)' : l === 1 ? 'Show the folders under it: the planets of a star, the moons of a planet' : 'Show its folders and its files (satellites)'}
            >
              {SUN_LEVEL_NAMES[l]}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}
