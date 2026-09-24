import { useAether } from '../store'
import { MOD } from '../util'

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Everywhere',
    rows: [
      [`${MOD} K · /`, 'Search neurons & commands'],
      [`${MOD} N · c`, 'Quick capture → Inbox'],
      ['d', "Today's daily note"],
      ['1 2 3 4 5 6', 'Graph · Editor · Capture · Search · Review · Projects'],
      ['p', 'Projects board'],
      ['?', 'This cheatsheet'],
      ['Esc', 'Close / clear filters / deselect'],
    ],
  },
  {
    title: 'Graph',
    rows: [
      ['click · dbl-click', 'Select · open'],
      ['drag node', 'Pin it somewhere else'],
      ['e · Enter', 'Open selected in editor'],
      ['f', 'Fly to selected'],
      ['Tab · ⇧Tab', 'Cycle neighbors'],
      ['← → ↑ ↓', 'Orbit camera (⇧ = pan)'],
      ['+ −', 'Zoom'],
      ['Home · 0', 'Reset camera'],
      ['t', 'Constellation ↔ Orbit (time)'],
      ['m', 'Color: area → type → tag → age'],
      ['b · l', 'Bloom · hub labels'],
      ['Alt ← →', 'History back / forward'],
    ],
  },
  {
    title: 'Editor',
    rows: [
      ['[[', 'Link autocomplete (↑↓ Enter)'],
      [`${MOD} S`, 'Save now (autosaves anyway)'],
      [`${MOD} E`, 'Edit ↔ split ↔ preview'],
      [`${MOD} Enter`, 'Save & back to graph'],
      ['Tab', 'Indent'],
    ],
  },
  {
    title: 'Projects',
    rows: [
      ['j k', 'Next / previous project'],
      ['n', 'Add a task (written to ## To do)'],
      ['click ☐', 'Tick — saved as [x] ✅ date'],
      ['⇧N', 'New project note'],
      ['x', 'Show / hide done list'],
      ['Enter · o', 'Open the note'],
    ],
  },
  {
    title: 'Review',
    rows: [
      ['j k', 'Next / previous'],
      ['1 2 3', 'Still true · tomorrow · archive'],
      ['p a s', 'Inbox → Projects · Areas · Resources'],
      ['o', 'Edit this note'],
    ],
  },
]

export function Help() {
  const open = useAether((s) => s.helpOpen)
  const setHelp = useAether((s) => s.setHelp)
  if (!open) return null
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)} role="dialog" aria-label="Keyboard shortcuts">
      <div className="panel rise w-[760px] max-w-[94vw] p-5">
        <div className="mb-3 flex items-center">
          <div className="text-[15px] font-semibold text-white">Keyboard</div>
          <span className="ml-2 text-[12px] text-dim">every feature has a key</span>
          <span className="flex-1" />
          <button type="button" className="hud-btn" onClick={() => setHelp(false)} autoFocus>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="section-title mb-1.5">{g.title}</div>
              {g.rows.map(([k, d]) => (
                <div key={k} className="flex items-baseline gap-3 py-[3px] text-[12.5px]">
                  <span className="w-28 shrink-0 font-mono text-[11.5px] text-accent2">{k}</span>
                  <span className="text-dim">{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
