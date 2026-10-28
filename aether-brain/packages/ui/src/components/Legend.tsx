import { useMemo } from 'react'
import { AREAS, type Area, type LegendBody } from '@aether/core'
import {
  AREA_COLORS,
  AREA_LABELS,
  BOARD_SUN_COLOR,
  IMAGE_COLOR,
  PICTURE_SIZES,
  PICTURE_SIZE_NAMES,
  STAR_COLOR,
  SUN_COLOR,
  TODAY_COLOR,
  tagColor,
  type PictureSize,
} from '@aether/graph'
import { useAether } from '../store'
import { cx } from '../util'

/**
 * Bottom-left legend: what the bodies are (the system layout's stars, planets
 * and moons; pictures; the ☀ Today hub), area constellations + top tags.
 * Chips filter the graph; the Today entry flies to the hub.
 */
/** The picture size buttons' labels, like Windows' icon views. */
const SIZE_LABELS: Record<PictureSize, string> = { medium: 'M', large: 'L', xl: 'XL' }

/** One of the legend's kinds of body: a chip that lights up every body of that kind, and stops when pressed again. */
function KindChip({ kind, title, children }: { kind: LegendBody; title: string; children: React.ReactNode }) {
  const on = useAether((s) => s.filters.bodies.has(kind))
  const toggleBody = useAether((s) => s.toggleBody)
  return (
    <button type="button" className={cx('chip', on && 'active')} aria-pressed={on} onClick={() => toggleBody(kind)} title={`${title} · click to light up all of them`}>
      {children}
    </button>
  )
}

export function Legend() {
  const graph = useAether((s) => s.graph)
  const pictureSize = useAether((s) => s.settings.pictureSize)
  const setSettings = useAether((s) => s.setSettings)
  const filters = useAether((s) => s.filters)
  const toggleArea = useAether((s) => s.toggleArea)
  const toggleTag = useAether((s) => s.toggleTag)
  const clearFilters = useAether((s) => s.clearFilters)
  const activeTag = useAether((s) => s.activeTag)
  const setActiveTag = useAether((s) => s.setActiveTag)
  const setFilters = useAether((s) => s.setFilters)
  const layoutMode = useAether((s) => s.settings.layoutMode)
  const depth = useAether((s) => s.settings.folderDepth)
  const motion = useAether((s) => s.settings.motion)
  const calm = useAether((s) => s.settings.calm)
  const sound = useAether((s) => s.settings.sound)
  const toggleSound = useAether((s) => s.toggleSound)
  const setFolderDepth = useAether((s) => s.setFolderDepth)
  const toggleMotion = useAether((s) => s.toggleMotion)
  const toggleCalm = useAether((s) => s.toggleCalm)
  const brief = useAether((s) => s.brief)
  const todayHub = useAether((s) => s.settings.todayHub)
  const showToday = useAether((s) => s.showToday)

  const tags = useMemo(() => {
    if (!graph) return []
    return [...graph.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  }, [graph])
  const pictures = useMemo(() => graph?.nodes.reduce((n, node) => (node.kind === 'image' ? n + 1 : n), 0) ?? 0, [graph])
  /** Reference boards with pictures orbiting them (suns of the system layout). */
  const boards = useMemo(() => graph?.nodes.reduce((n, node) => (node.board ? n + 1 : n), 0) ?? 0, [graph])

  if (!graph) return null
  const anyFilter = filters.areas.size > 0 || filters.tags.size > 0 || filters.types.size > 0 || filters.bodies.size > 0 || !!filters.query
  const system = layoutMode === 'system'

  return (
    <div className="panel flex max-w-[520px] flex-col gap-2 p-3" aria-label="Legend and filters">
      {(system || pictures > 0 || (todayHub && brief)) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-dim">
          {todayHub && brief && (
            <button type="button" className="hud-btn !h-6 !px-2" onClick={showToday} title="The Today hub: today's to-dos from every project (y)">
              <span style={{ color: TODAY_COLOR, textShadow: `0 0 8px ${TODAY_COLOR}` }}>☀</span> Today · {brief.total}
            </button>
          )}
          {system && (
            <>
              <KindChip kind="galaxy" title="A drive (or the whole vault), or a folder you marked as a galaxy (✦): the folders on it lie on its disc">
                <span style={{ color: SUN_COLOR, textShadow: `0 0 8px ${SUN_COLOR}` }}>◉</span> galaxy · drive
              </KindChip>
              <KindChip kind="star" title="A folder directly in a galaxy. The brighter the star, the more you open and save in it lately; a project is the biggest">
                <span style={{ color: STAR_COLOR, textShadow: `0 0 8px ${STAR_COLOR}` }}>★</span> star · folder
              </KindChip>
              <KindChip kind="planet" title="A folder directly in a star">
                <span style={{ color: IMAGE_COLOR }}>●</span> planet · sub-folder
              </KindChip>
              <KindChip kind="moon" title="A folder in a planet, or in another moon: moons nest as deep as your folders go. Files orbit moons">
                <span className="text-ink">◦</span> moon · deeper folder
              </KindChip>
              <KindChip kind="satellite" title="A file. A bigger one (a picture, video, model or long note) is drawn bigger. A faster orbit is more urgent">
                <span className="text-ink">·</span> satellite · file
              </KindChip>
              {boards > 0 && (
                <KindChip kind="sun" title="A reference board with pictures on it is a sun: the pictures orbit it instead of their folders (open it from the Boards view, 8)">
                  <span style={{ color: BOARD_SUN_COLOR, textShadow: `0 0 8px ${BOARD_SUN_COLOR}` }}>▣</span> sun · board · {boards}
                </KindChip>
              )}
            </>
          )}
          {pictures > 0 && (
            <KindChip kind="picture" title={system ? "A picture file: each folder's newest ones orbit it, embedded ones link to their notes" : 'A picture file a note embeds (![[name.png]])'}>
              <span style={{ color: IMAGE_COLOR }}>🖼</span> picture · {pictures}
            </KindChip>
          )}
          {pictures > 0 && (
            <span className="flex items-center gap-0.5" role="group" aria-label="Picture size (z)" title="Picture size: medium, large or extra large icons (z)">
              {PICTURE_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  className={cx('hud-btn !h-6 !px-1.5', pictureSize === size ? '!border-accent/60 text-ink' : 'text-dim')}
                  aria-pressed={pictureSize === size}
                  aria-label={PICTURE_SIZE_NAMES[size]}
                  onClick={() => setSettings({ pictureSize: size })}
                >
                  {SIZE_LABELS[size]}
                </button>
              ))}
            </span>
          )}
          {system && (
            <>
              <span className="flex-1" />
              <span className="flex items-center gap-1" title="How many folder levels show without expanding ([ and ])">
                depth
                <button type="button" className="hud-btn !h-6 !px-1.5" onClick={() => setFolderDepth(depth - 1)} disabled={depth <= 1} aria-label="Fewer folder levels ([)">
                  −
                </button>
                <span className="w-3 text-center tabular-nums text-ink">{depth}</span>
                <button type="button" className="hud-btn !h-6 !px-1.5" onClick={() => setFolderDepth(depth + 1)} disabled={depth >= 8} aria-label="More folder levels (])">
                  +
                </button>
              </span>
              <button type="button" className="hud-btn !h-6 !px-2" aria-pressed={motion} onClick={toggleMotion} title="Orbits moving / paused (o)">
                {motion ? '↻ orbiting' : '❚❚ paused'}
              </button>
              <button
                type="button"
                className="hud-btn !h-6 !px-2"
                aria-pressed={calm}
                onClick={toggleCalm}
                title="Calm orbits (⇧O): urgency speeds an orbit up less, so none runs faster than a normal one"
              >
                ☾ calm
              </button>
              <button
                type="button"
                className="hud-btn !h-6 !px-2"
                aria-pressed={sound}
                onClick={toggleSound}
                title="Sound (⇧M): a note for every star, planet and moon you click"
              >
                {sound ? '♪ sound' : '♪ muted'}
              </button>
            </>
          )}
        </div>
      )}
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
            {filters.bodies.size ? `${[...filters.bodies].join(' + ')} · ` : ''}
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
