import { useMemo } from 'react'
import { AREAS, type Area } from '@aether/core'
import { AREA_COLORS, AREA_LABELS, tagColor } from '@aether/graph'
import { useAether } from '../store'
import { cx } from '../util'

/** Bottom-left legend: area constellations + top tags. Chips filter the graph. */
export function Legend() {
  const graph = useAether((s) => s.graph)
  const filters = useAether((s) => s.filters)
  const toggleArea = useAether((s) => s.toggleArea)
  const toggleTag = useAether((s) => s.toggleTag)
  const clearFilters = useAether((s) => s.clearFilters)
  const activeTag = useAether((s) => s.activeTag)
  const setActiveTag = useAether((s) => s.setActiveTag)
  const setFilters = useAether((s) => s.setFilters)

  const tags = useMemo(() => {
    if (!graph) return []
    return [...graph.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  }, [graph])

  if (!graph) return null
  const anyFilter = filters.areas.size > 0 || filters.tags.size > 0 || filters.types.size > 0 || !!filters.query

  return (
    <div className="panel flex max-w-[520px] flex-col gap-2 p-3" aria-label="Legend and filters">
      <div className="flex flex-wrap items-center gap-1.5">
        {AREAS.map((a: Area) => {
          const count = graph.areaCounts.get(a) ?? 0
          if (!count && a === 'untagged') return null
          return (
            <button
              type="button"
              key={a}
              className={cx('chip', filters.areas.has(a) && 'active')}
              onClick={() => toggleArea(a)}
              style={{ color: filters.areas.size === 0 || filters.areas.has(a) ? undefined : 'var(--text-faint)' }}
              title={`Filter to ${AREA_LABELS[a]}`}
            >
              <span className="dot" style={{ background: AREA_COLORS[a], color: AREA_COLORS[a] }} />
              {AREA_LABELS[a]}
              <span className="opacity-60">{count}</span>
            </button>
          )
        })}
        {graph.orphans.length > 0 && (
          <button
            type="button"
            className={cx('chip', filters.query === 'is:orphan' && 'active')}
            onClick={() => setFilters({ query: filters.query === 'is:orphan' ? '' : 'is:orphan' })}
            title="Notes with no links in or out"
          >
            <span className="dot" style={{ background: '#5f678a', color: '#5f678a' }} />
            orphans <span className="opacity-60">{graph.orphans.length}</span>
          </button>
        )}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map(([t, n]) => (
            <button
              type="button"
              key={t}
              className={cx('chip', (filters.tags.has(t) || activeTag === t) && 'active')}
              onClick={(e) => (e.shiftKey || e.altKey ? setActiveTag(activeTag === t ? null : t) : toggleTag(t))}
              title="Click: filter · Shift+click: show tag field"
            >
              <span className="dot" style={{ background: tagColor(t), color: tagColor(t) }} />#{t}
              <span className="opacity-60">{n}</span>
            </button>
          ))}
        </div>
      )}
      {(anyFilter || activeTag) && (
        <div className="flex items-center gap-2 text-[11px] text-dim">
          <span>
            {filters.query ? `“${filters.query}” · ` : ''}
            {activeTag ? `field #${activeTag} · ` : ''}
            dimming everything else
          </span>
          <button
            type="button"
            className="text-accent2 hover:underline"
            onClick={() => {
              clearFilters()
              setActiveTag(null)
            }}
          >
            clear <kbd>Esc</kbd>
          </button>
        </div>
      )}
    </div>
  )
}
