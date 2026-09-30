import { TODAY_ID } from '@aether/core'
import { TODAY_COLOR, type LayoutMode } from '@aether/graph'
import { useAether, type View } from '../store'
import { cx, MOD } from '../util'

const LAYOUT_LABEL: Record<LayoutMode, string> = { constellation: '✧ Constellation', orbit: '◎ Orbit', system: '☀ System' }

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'graph', label: 'Graph', key: '1' },
  { id: 'editor', label: 'Editor', key: '2' },
  { id: 'capture', label: 'Capture', key: '3' },
  { id: 'search', label: 'Search', key: '4' },
  { id: 'review', label: 'Review', key: '5' },
  { id: 'projects', label: 'Projects', key: '6' },
]

export function TopBar({ onPickVault }: { onPickVault?: (() => void) | undefined }) {
  const view = useAether((s) => s.view)
  const setView = useAether((s) => s.setView)
  const setPalette = useAether((s) => s.setPalette)
  const adapter = useAether((s) => s.adapter)
  const graph = useAether((s) => s.graph)
  const settings = useAether((s) => s.settings)
  const setSettings = useAether((s) => s.setSettings)
  const toggleLayout = useAether((s) => s.toggleLayout)
  const cycleColorMode = useAether((s) => s.cycleColorMode)
  const setHelp = useAether((s) => s.setHelp)
  const fps = useAether((s) => s.fps)
  const dirty = useAether((s) => s.dirty)
  const status = useAether((s) => s.status)
  const brief = useAether((s) => s.brief)
  const todaySelected = useAether((s) => s.selectedId === TODAY_ID)
  const showToday = useAether((s) => s.showToday)

  // Neurons are notes; folder nodes (system layout) and pictures are counted apart, the Today hub not at all.
  let nodes = 0
  let ghosts = 0
  let folders = 0
  let pictures = 0
  for (const n of graph?.nodes ?? []) {
    if (n.kind === 'note') nodes++
    else if (n.kind === 'ghost') ghosts++
    else if (n.kind === 'folder') folders++
    else if (n.kind === 'image') pictures++
  }
  const edges = graph?.edges.length ?? 0
  const late = brief?.overdue.length ?? 0

  return (
    <header className="panel flex items-center gap-1 px-2 py-1.5" role="banner">
      <div className="mr-2 flex items-center gap-2 pl-1">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{ background: 'radial-gradient(circle at 35% 35%, #fff, #8f7cff 45%, #4de2ff 100%)', boxShadow: '0 0 14px #8f7cff' }}
          aria-hidden
        />
        <span className="text-[13px] font-semibold tracking-wide text-white">Aether Brain</span>
      </div>

      <nav className="flex items-center gap-0.5" aria-label="Views">
        {VIEWS.map((v) => (
          <button
            type="button"
            key={v.id}
            className="hud-btn"
            aria-pressed={view === v.id || (v.id === 'search' && useAether.getState().paletteOpen)}
            onClick={() => (v.id === 'search' ? setPalette(true) : setView(v.id))}
            title={`${v.label} (${v.key})`}
          >
            {v.label}
            <kbd>{v.key}</kbd>
          </button>
        ))}
      </nav>

      {status === 'ready' && brief && (
        <button
          type="button"
          className="hud-btn ml-1"
          aria-pressed={todaySelected}
          onClick={showToday}
          title={`Today — daily brief (y): ${late} overdue · ${brief.today.length} today · ${brief.next.length} next up`}
        >
          <span style={{ color: TODAY_COLOR, textShadow: `0 0 8px ${TODAY_COLOR}` }} aria-hidden>
            ☀
          </span>
          Today
          <span className="tabular-nums text-ink">{brief.total}</span>
          {late > 0 && <span className="h-1.5 w-1.5 rounded-full bg-danger" style={{ boxShadow: '0 0 6px var(--danger)' }} aria-label={`${late} overdue`} role="img" />}
          <kbd>y</kbd>
        </button>
      )}

      <span className="flex-1" />

      <button type="button" className="hud-btn" onClick={() => setPalette(true)} title={`Search (${MOD}+K)`}>
        ⌕ Search <kbd>{MOD} K</kbd>
      </button>
      <button type="button" className="hud-btn" aria-pressed={settings.layoutMode !== 'constellation'} onClick={toggleLayout} title="Layout: constellation → orbit (time) → system (folders) (t)">
        {LAYOUT_LABEL[settings.layoutMode] ?? LAYOUT_LABEL.system}
      </button>
      <button type="button" className="hud-btn" onClick={cycleColorMode} title="Cycle color mode (m)">
        ◐ {settings.colorMode}
      </button>
      <button type="button" className="hud-btn" aria-pressed={settings.bloom} onClick={() => setSettings({ bloom: !settings.bloom })} title="Bloom (b)">
        ✺
      </button>
      <button type="button" className="hud-btn" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)">
        ?
      </button>

      <div className="ml-2 flex items-center gap-2 border-l border-[var(--line)] pl-3 text-[11px] text-faint">
        <button type="button" className={cx('hud-btn !h-7 !px-2', onPickVault && 'hover:text-ink')} onClick={onPickVault} title={adapter?.location ?? ''} disabled={!onPickVault}>
          <span className="max-w-[160px] truncate">{adapter?.name ?? 'No vault'}</span>
          {adapter?.readOnly && <span className="text-inbox">·ro</span>}
        </button>
        <span title={`Neurons (notes) / synapses / missing${settings.layoutMode === 'system' ? ' / folders shown' : ''} / pictures shown`}>
          {status === 'ready'
            ? `${nodes}n · ${edges}s${ghosts ? ` · ${ghosts}?` : ''}${settings.layoutMode === 'system' && folders ? ` · ${folders}f` : ''}${pictures ? ` · ${pictures}🖼` : ''}`
            : status === 'loading'
              ? 'loading…'
              : ''}
        </span>
        <span className={cx('tabular-nums', fps && fps < 45 ? 'text-inbox' : '')} title="Frames per second">
          {fps ? `${fps} fps` : ''}
        </span>
        {dirty && <span className="text-inbox">●</span>}
      </div>
    </header>
  )
}
