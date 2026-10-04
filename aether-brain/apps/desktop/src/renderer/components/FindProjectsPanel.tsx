/**
 * Find projects (⇧P): looks through the vault's folders for the user's own
 * projects — an Unreal, Unity or Godot project, a git repository, a code
 * project, a folder of Blender, ZBrush, Photoshop … files — and makes the
 * ticked ones ★ stars in one go. Looking writes nothing (main lists each
 * folder once, src/main/projects.ts); each ticked folder gets its project
 * note (store.makeProjects), nothing else changes. When a vault opens with at
 * most one star, a toast offers this once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { registerCommands, registerHelpRows, registerKey, useAether } from '@aether/ui'
import type { ProjectScanDto, ProjectScanProgressDto } from '../../shared/ipc'
import { ElectronVaultAdapter } from '../vault/electron'
import { errorText, openPanel, togglePanel } from '../panels'
import { projectStars } from '../forge-star'
import { reviewRows, tickedPaths, wantsHint, type KnownStar, type ProjectRow } from '../find-projects'
import { ErrorLine, Overlay, Section } from './Overlay'

const bridge = ElectronVaultAdapter.bridge()

/** The stars the vault has now: folder and title. */
function knownStars(): KnownStar[] {
  const { notes, folders } = useAether.getState()
  return projectStars(notes.values(), folders).map((c) => ({ path: c.path, name: c.names[1] ?? c.names[0] ?? c.path }))
}

function Row({ row, ticked, onToggle, disabled }: { row: ProjectRow; ticked: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2 hover:border-accent/60">
      <input type="checkbox" className="mt-[3px]" checked={ticked} disabled={disabled} onChange={onToggle} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13.5px] font-semibold text-white">{row.name}</span>
          <span className={`shrink-0 text-[11.5px] ${row.strong ? 'text-accent' : 'text-dim'}`}>
            {row.kind}
            {row.files > 0 && ` · ${row.files} files`}
          </span>
        </span>
        <span className="block truncate text-[11.5px] text-faint">
          {row.path}
          {row.inside && ` · inside ${row.inside}`}
        </span>
      </span>
    </label>
  )
}

export function FindProjectsPanel() {
  const adapter = useAether((s) => s.adapter)
  const notes = useAether((s) => s.notes)
  const onDisk = adapter?.kind === 'electron'
  const readOnly = adapter?.readOnly ?? true
  const [scan, setScan] = useState<ProjectScanDto | null>(null)
  const [progress, setProgress] = useState<ProjectScanProgressDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [making, setMaking] = useState(false)
  const run = useRef(0)

  const look = useCallback(() => {
    if (!bridge || !onDisk) return
    const mine = ++run.current
    setScan(null)
    setProgress(null)
    setError(null)
    bridge.findProjects().then(
      (r) => {
        if (run.current !== mine) return
        setScan(r)
        setTicked(new Set(reviewRows(r.candidates, knownStars()).filter((x) => x.ticked).map((x) => x.path)))
      },
      (err) => run.current === mine && setError(errorText(err)),
    )
  }, [onDisk])

  // Look when the panel opens; closing it stops looking.
  useEffect(() => {
    if (!bridge) return
    const off = bridge.onFindProgress((p) => setProgress(p))
    look()
    return () => {
      run.current++
      off()
      void bridge.findProjectsStop()
    }
  }, [look])

  // Stars made meanwhile (by hand, an AI) drop out of the list.
  const rows = useMemo(() => (scan ? reviewRows(scan.candidates, knownStars()) : []), [scan, notes])
  const chosen = tickedPaths(rows, ticked)
  const looking = onDisk && !scan && !error

  const tick = (which: 'all' | 'sure' | 'none') =>
    setTicked(new Set(which === 'none' ? [] : rows.filter((r) => which === 'all' || (r.strong && r.ticked)).map((r) => r.path)))
  const toggle = (path: string) =>
    setTicked((t) => {
      const next = new Set(t)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const make = async () => {
    if (!chosen.length || making) return
    setMaking(true)
    const res = await useAether.getState().makeProjects(chosen)
    setMaking(false)
    if (res.made > 0 && !res.failed) openPanel(null)
    else if (res.error) setError(res.error)
  }

  const busy = making || looking || !scan
  // The overlay takes its keys once, when it opens: they reach this render's state through a ref.
  const latest = useRef({ busy, tick })
  latest.current = { busy, tick }
  const keys = useMemo(() => {
    const key = (which: 'all' | 'sure' | 'none') => () => !latest.current.busy && latest.current.tick(which)
    return { P: () => openPanel(null), a: key('all'), s: key('sure'), n: key('none') }
  }, [])
  return (
    <Overlay title="Find projects" hint="your project folders become ★ stars" width="w-[760px]" keys={keys}>
      <ErrorLine text={error} />
      {!onDisk ? (
        <p className="text-[12.5px] text-dim">Find projects looks through folders on disk: open a vault folder or whole drives first (v).</p>
      ) : looking ? (
        <div className="flex items-center gap-3 text-[12.5px] text-dim">
          <span>
            Looking into folders{progress ? ` · ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : '…'} (names only: nothing is opened or written)
          </span>
          <span className="flex-1" />
          <button type="button" className="hud-btn" onClick={() => void bridge?.findProjectsStop()}>
            Stop
          </button>
        </div>
      ) : scan ? (
        <>
          <Section
            title={rows.length ? `${rows.length} project folder${rows.length === 1 ? '' : 's'} found` : 'No new projects found'}
            aside={`looked into ${scan.looked.toLocaleString()} folders${scan.cancelled ? ' · stopped early' : ''}${scan.truncated ? ' · not every folder (the vault is very big)' : ''}`}
          >
            {rows.length ? (
              <>
                <p className="mb-3 text-[12px] text-dim">
                  Each ticked folder gets one note named after it with <code>type: project</code> (or its own folder note gets that line): that note is the star. Nothing else in the folder
                  changes. Sure ones are engine, code and git projects; the rest were found by their art files.
                </p>
                <div className="flex flex-col gap-1.5">
                  {rows.map((r) => (
                    <Row key={r.path} row={r} ticked={ticked.has(r.path)} disabled={making} onToggle={() => toggle(r.path)} />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-dim">
                No folder looked like an engine, code or git project, or held art files (Blender, ZBrush, Photoshop …). Make one by hand: select its planet, then the palette's
                “Make the selected folder a project”.
              </p>
            )}
          </Section>
          <div className="flex flex-wrap items-center gap-2">
            {rows.length > 0 && (
              <button type="button" className="hud-btn primary" data-autofocus disabled={!chosen.length || making || readOnly} onClick={() => void make()}>
                {making ? 'Making stars…' : `Make ${chosen.length} star${chosen.length === 1 ? '' : 's'}`}
              </button>
            )}
            {rows.length > 1 && (
              <span className="text-[12px] text-dim">
                Tick:{' '}
                <button type="button" className="hud-btn" disabled={making} onClick={() => tick('all')}>
                  all <kbd>a</kbd>
                </button>{' '}
                <button type="button" className="hud-btn" disabled={making} onClick={() => tick('sure')}>
                  sure ones <kbd>s</kbd>
                </button>{' '}
                <button type="button" className="hud-btn" disabled={making} onClick={() => tick('none')}>
                  none <kbd>n</kbd>
                </button>
              </span>
            )}
            <span className="flex-1" />
            <button type="button" className="hud-btn" disabled={making} onClick={look}>
              Look again
            </button>
          </div>
          {readOnly && <p className="mt-3 text-[12px] text-dim">This vault is read-only: stars can't be made here.</p>}
        </>
      ) : null}
    </Overlay>
  )
}

/* ------------------------------------------------------------------ */
/* Key, palette, cheatsheet, the hint                                  */
/* ------------------------------------------------------------------ */

const HINT_KEY = 'aether:find-projects-hinted'

/** Vaults (their location) the hint was shown for, kept so it shows once per vault. */
function hinted(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HINT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function markHinted(location: string): void {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify([...hinted().filter((x) => x !== location), location].slice(-20)))
  } catch {
    /* no storage: the hint may show again next time */
  }
}

/** Once a vault on disk is ready with at most one star, offer Find projects (once per vault). */
function offerOnce(): void {
  const s = useAether.getState()
  const a = s.adapter
  if (s.status !== 'ready' || a?.kind !== 'electron' || a.readOnly) return
  if (hinted().includes(a.location)) return
  const stars = knownStars().length
  if (!wantsHint(stars, s.folders.size)) return
  markHinted(a.location)
  s.toast(
    stars ? 'Only one ★ star in this brain. Find your other projects?' : 'No ★ stars in this brain yet. Find your projects?',
    'info',
    { label: 'Find projects (⇧P)', run: () => openPanel('find') },
  )
}

export function registerFindProjects(): void {
  if (!bridge) return
  registerKey('P', () => togglePanel('find'))
  registerCommands([
    { id: 'find-projects', title: 'Find projects: make your project folders ★ stars…', keys: 'Shift+P', group: 'vault', run: () => openPanel('find') },
  ])
  registerHelpRows('Desktop', [['⇧P', 'Find projects: Unreal, Unity, git, art folders … become ★ stars']])
  // Once per opened vault, when its first graph is in: `ready` comes a moment before the notes and folders.
  let checked: unknown = null
  useAether.subscribe((s, prev) => {
    if (s.status !== 'ready' || s.graph === prev.graph || !s.adapter || s.adapter === checked) return
    checked = s.adapter
    offerOnce()
  })
}
