import { useAether } from '../store'
import { MOD } from '../util'

interface HelpGroup {
  title: string
  rows: [string, string][]
}

const GROUPS: HelpGroup[] = [
  {
    title: 'Everywhere',
    rows: [
      [`${MOD} K · /`, 'Search neurons, folders & commands'],
      [`${MOD} N · c`, 'Quick capture → Inbox'],
      ['y · 7', 'Today — the daily brief (☀ hub)'],
      ['i', 'Import AI chats (Claude / ChatGPT export)'],
      ['d', "Today's daily note"],
      ['1 2 3 4 5 6', 'Graph · Editor · Capture · Search · Review · Projects'],
      ['p', 'Projects board (a selected ★ star: its board)'],
      ['u', "The newest toast's action (Undo, Show)"],
      ['?', 'This cheatsheet'],
      ['Esc', 'Close / clear filters / deselect'],
    ],
  },
  {
    title: 'Graph',
    rows: [
      ['click · dbl-click', 'Select · open (a folder: expand)'],
      ['drag node', 'Pin it somewhere else'],
      ['e · Enter', 'Open selected (a folder: expand · a picture: image app · a video: video player)'],
      ['f', 'Fly to selected'],
      ['Tab · ⇧Tab', 'Cycle neighbors (a folder: parent + children)'],
      ['← → ↑ ↓', 'Orbit camera (⇧ = pan)'],
      ['+ −', 'Zoom'],
      ['Home · 0', 'Reset camera'],
      ['t', 'Layout: constellation → orbit → system'],
      ['m', 'Color: area → type → tag → age'],
      ['z', 'Pictures: medium → large → extra large icons'],
      ['b · l', 'Bloom · hub labels'],
      ['Alt ← →', 'History back / forward'],
    ],
  },
  {
    title: 'System layout',
    rows: [
      ['★ ● ·', 'Star = project or drive · planet = folder · moon = note'],
      ['x', 'Expand / collapse the selected folder'],
      ['[ ]', 'Show fewer / more folder levels'],
      ['o', 'Orbits moving / paused'],
      ['⇧ G', "Star gallery: a star's pictures in 3D (also opens as you fly close)"],
      ['⇧ H', 'Leave the selected folder out of the brain (desktop; Undo on the toast, or v)'],
    ],
  },
  {
    title: 'Today & pictures',
    rows: [
      ['y · 7', 'Fly to the ☀ Today hub; its brief shows on the right'],
      ['Tab · ↑ ↓', 'Into the brief · task to task'],
      ['Space', 'Tick the focused task (u undoes)'],
      ['e · Enter', 'A picture: open it in your image app · a video (a still, ▶): play it in your player'],
      ['drop files', 'Import pictures into the selected folder'],
      ['drop a .zip', 'Import a Claude / ChatGPT export (i picks one)'],
      ['> picture', 'Palette: import, copy embed, moons, thumbnails'],
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
      ['Enter · o', 'Open the note'],
      ['e · s', 'Rename the project · cycle its status'],
      ['f', 'Add a folder (planet) to the project'],
      ['n', 'Add a task (written to ## To do)'],
      ['click ☐ · Space', 'Tick — saved as [x] ✅ date'],
      ['Enter · dbl-click', 'Edit the focused task'],
      ['Alt ↑ ↓', 'Move the focused task'],
      ['Del · u', 'Delete the focused task · undo'],
      ['⇧N', 'New project note'],
      ['x', 'Show / hide done list'],
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

/** Rows added by the host app (e.g. the desktop's `v` and `a` panels). */
const extraGroups: HelpGroup[] = []

/**
 * Add cheatsheet rows from outside the package (desktop-only UI). Rows go
 * into the group with that title (a new group when there is none); a row
 * whose key is already listed in the group replaces it.
 */
export function registerHelpRows(group: string, rows: [string, string][]): void {
  let g = extraGroups.find((x) => x.title === group)
  if (!g) {
    g = { title: group, rows: [] }
    extraGroups.push(g)
  }
  for (const row of rows) {
    const i = g.rows.findIndex(([k]) => k === row[0])
    if (i >= 0) g.rows[i] = row
    else g.rows.push(row)
  }
}

/** Built-in groups with the registered rows merged in. */
function helpGroups(): HelpGroup[] {
  const out = GROUPS.map((g) => ({ title: g.title, rows: [...g.rows] }))
  for (const x of extraGroups) {
    const g = out.find((o) => o.title === x.title)
    if (!g) {
      out.push({ title: x.title, rows: [...x.rows] })
      continue
    }
    for (const row of x.rows) if (!g.rows.some(([k]) => k === row[0])) g.rows.push(row)
  }
  return out
}

export function Help() {
  const open = useAether((s) => s.helpOpen)
  const setHelp = useAether((s) => s.setHelp)
  if (!open) return null
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)} role="dialog" aria-label="Keyboard shortcuts">
      <div className="panel rise scroll max-h-[92vh] w-[800px] max-w-[94vw] p-5">
        <div className="mb-3 flex items-center">
          <div className="text-[15px] font-semibold text-white">Keyboard</div>
          <span className="ml-2 text-[12px] text-dim">every feature has a key</span>
          <span className="flex-1" />
          <button type="button" className="hud-btn" onClick={() => setHelp(false)} autoFocus>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          {helpGroups().map((g) => (
            <div key={g.title}>
              <div className="section-title mb-1.5">{g.title}</div>
              {g.rows.map(([k, d]) => (
                <div key={k} className="flex items-baseline gap-3 py-[3px] text-[12.5px]">
                  <span className="w-32 shrink-0 font-mono text-[11.5px] text-accent2">{k}</span>
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
