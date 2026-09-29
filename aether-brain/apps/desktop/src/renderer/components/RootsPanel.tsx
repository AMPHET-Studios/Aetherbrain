import { useEffect, useState } from 'react'
import { useAether } from '@aether/ui'
import type { VaultInfo } from '../../shared/ipc'
import { ElectronVaultAdapter } from '../vault/electron'
import { UNSAVED_NOTE, errorText, openPanel, samePath, saveOpenNote } from '../panels'
import { ErrorLine, Overlay, Section } from './Overlay'

/** What the scanner always leaves out, in words (see HEAVY_DIRS in main/fsvault.ts). */
const ALWAYS_SKIPPED =
  'hidden folders, Windows, Program Files, ProgramData, AppData, $Recycle.Bin, node_modules, build, dist, cache, temp, and game-engine caches (Saved, Intermediate, DerivedDataCache)'

const MIRROR_NOTE =
  'Mirroring a drive scans every folder on it except system, build and cache folders, so its real folder tree becomes planets and moons. Big drives take a while the first time.'

/** Comma-separated folder names → list; null plus a message when one is a path. */
function parseNames(text: string): { names: string[]; error: string | null } {
  const names = text
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const bad = names.find((n) => /[\\/]/.test(n))
  return { names, error: bad ? `"${bad}" is a path. Type folder names only (every folder with that name is skipped).` : null }
}

/** Load the vault main just (re)opened into the app. Not awaited: the load shows its own progress. */
function load(info: VaultInfo): void {
  void useAether.getState().openVault(ElectronVaultAdapter.fromInfo(info))
}

/** Vault folders overlay (`v`), or the whole-drive picker opened from the welcome screen. */
export function RootsPanel({ mode }: { mode: 'roots' | 'drives' }) {
  return mode === 'drives' ? <DrivePicker /> : <Roots />
}

/** Drive roots on Windows (empty elsewhere); null while probing. */
function useDrives(): string[] | null {
  const [drives, setDrives] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    const b = ElectronVaultAdapter.bridge()
    if (!b) {
      setDrives([])
      return
    }
    b.listDrives().then(
      (d) => alive && setDrives(d),
      () => alive && setDrives([]),
    )
    return () => {
      alive = false
    }
  }, [])
  return drives
}

function Roots() {
  const bridge = ElectronVaultAdapter.bridge()
  const adapter = useAether((s) => s.adapter)
  const status = useAether((s) => s.status)
  const storeError = useAether((s) => s.error)
  const progress = useAether((s) => s.loadProgress)
  const noteCount = useAether((s) => s.notes.size)
  const electron = adapter instanceof ElectronVaultAdapter ? adapter : null
  const info = electron?.info ?? null
  const roots = info?.roots ?? []
  const multi = roots.length > 1
  const platform = bridge?.platform ?? ''
  const drives = useDrives()
  const [exclude, setExclude] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loading = status === 'loading'
  const locked = busy || loading || !bridge

  const [missing, setMissing] = useState<string[]>([])

  useEffect(() => setExclude(info?.exclude.join(', ') ?? ''), [info])

  // Remembered roots that could not be opened (an unplugged drive): listed so they can be forgotten.
  useEffect(() => {
    if (!bridge || !info) {
      setMissing([])
      return
    }
    let alive = true
    bridge.lastVault().then(
      (last) => alive && setMissing((last ?? []).filter((p) => !info.roots.some((r) => samePath(r.path, p, platform)))),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [bridge, info, platform])

  const forget = async (p: string) => {
    try {
      await bridge?.removeRoot(p)
    } catch {
      /* already forgotten (the list came from the command line) */
    }
    setMissing((m) => m.filter((x) => x !== p))
  }

  /** Run a main-process change; on success load the reopened vault into the app (the open note is saved first). */
  const run = async (action: () => Promise<VaultInfo | null>) => {
    if (locked) return
    setBusy(true)
    setError(null)
    try {
      if (!(await saveOpenNote())) throw new Error(UNSAVED_NOTE)
      const next = await action()
      if (next) load(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const rescan = async () => {
    if (locked) return
    setError(null)
    if (!(await saveOpenNote())) return setError(UNSAVED_NOTE)
    void useAether.getState().reload()
  }

  const freeDrives = (drives ?? []).filter((d) => !roots.some((r) => samePath(r.path, d, platform)))
  const parsed = parseNames(exclude)
  const excludeChanged = parsed.names.join('\u0000') !== (info?.exclude ?? []).join('\u0000')

  const saveExclude = () => {
    if (parsed.error) return setError(parsed.error)
    if (bridge && info && excludeChanged) void run(() => bridge.setExclude(parsed.names))
  }

  return (
    <Overlay
      title="Vault folders"
      hint="each folder is a planet, its notes orbit it; files stay where they are"
      keys={{ v: () => openPanel(null), a: () => openPanel('ai') }}
    >
      <ErrorLine text={error ?? (status === 'error' ? storeError : null)} />

      <Section title="Folders in this brain" aside={multi ? 'several roots: each one is a sun of its own' : undefined}>
        {roots.length === 0 ? (
          <p className="mb-2 text-[12.5px] text-dim">No folder vault is open. Open a folder, or add a whole drive below.</p>
        ) : (
          <ul className="mb-2 flex flex-col gap-1.5">
            {roots.map((r) => (
              <li key={r.path} className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: '#fff1d6', boxShadow: '0 0 10px #ffcf6b' }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-white">{r.label}</span>
                  <span className="block truncate font-mono text-[11.5px] text-dim" title={r.path}>
                    {r.path}
                  </span>
                </span>
                <button
                  type="button"
                  className="hud-btn"
                  onClick={() => void bridge?.revealInFolder(multi ? r.mount : '').catch((err: unknown) => setError(errorText(err)))}
                  aria-label={`Show ${r.label} in the file manager`}
                >
                  Show
                </button>
                <button
                  type="button"
                  className="hud-btn"
                  disabled={locked || !multi}
                  title={multi ? 'Stop showing this folder (nothing on disk is deleted)' : 'A vault needs at least one folder'}
                  onClick={() => bridge && void run(() => bridge.removeRoot(r.path))}
                  aria-label={`Remove ${r.label} from the brain`}
                >
                  Remove
                </button>
              </li>
            ))}
            {missing.map((p) => (
              <li key={p} className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--line)] px-3 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-faint" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px] text-dim">{p}</span>
                  <span className="block text-[11.5px] text-faint">not reachable right now; it comes back when it is</span>
                </span>
                <button type="button" className="hud-btn" disabled={locked} onClick={() => void forget(p)} aria-label={`Forget ${p}`}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="hud-btn primary"
            data-autofocus
            disabled={locked}
            onClick={() => bridge && void run(() => (info ? bridge.addRoot() : bridge.pickVault()))}
          >
            {info ? '+ Add folder…' : 'Open a folder…'}
          </button>
          {info && (
            <button type="button" className="hud-btn" disabled={locked} onClick={() => bridge && void run(() => bridge.pickVault())} title="Replace the whole vault with one folder">
              Open a different folder…
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="hud-btn" disabled={locked || !info} onClick={() => void rescan()} title="Read every folder again">
            Rescan
          </button>
        </div>
      </Section>

      {platform === 'win32' && (
        <Section title="Whole drives">
          <div className="mb-2 flex flex-wrap gap-2">
            {drives === null ? (
              <span className="text-[12px] text-faint">Looking for drives…</span>
            ) : freeDrives.length === 0 ? (
              <span className="text-[12px] text-faint">Every drive is already in the brain.</span>
            ) : (
              freeDrives.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="hud-btn"
                  disabled={locked}
                  onClick={() => bridge && void run(() => (info ? bridge.addRootPath(d) : bridge.openVault([d])))}
                  aria-label={`Mirror drive ${d}`}
                >
                  + {d}
                </button>
              ))
            )}
          </div>
          <p className="text-[11.5px] leading-relaxed text-faint">{MIRROR_NOTE}</p>
        </Section>
      )}

      <Section title="Skip these folders">
        <form
          className="mb-1.5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            saveExclude()
          }}
        >
          <input
            className="input !py-1.5 !text-[12.5px]"
            placeholder="Folder names, comma-separated: Backups, Old renders, Downloads"
            value={exclude}
            disabled={!info}
            onChange={(e) => setExclude(e.target.value)}
            aria-label="Folder names to skip, comma-separated"
          />
          <button type="submit" className="hud-btn" disabled={locked || !info || !excludeChanged}>
            Save
          </button>
        </form>
        <p className="text-[11.5px] leading-relaxed text-faint">Always skipped: {ALWAYS_SKIPPED}.</p>
      </Section>

      <div className="flex items-center gap-2 border-t border-[var(--line)] pt-3 text-[12px] text-dim" aria-live="polite">
        {loading ? (
          <>
            <span className="spin inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent" />
            {progress
              ? `${progress.label}… ${progress.done.toLocaleString()}${progress.total ? ` / ${progress.total.toLocaleString()}` : ''}`
              : 'Reading the vault…'}
          </>
        ) : info ? (
          <>
            <span>
              {noteCount.toLocaleString()} notes in {info.name}
            </span>
            {electron?.truncated && <span className="text-inbox">· the scan stopped at the folder limit; skip big folders above to see the rest</span>}
          </>
        ) : (
          <span>
            <kbd>v</kbd> opens this panel · <kbd>a</kbd> the AI link
          </span>
        )}
      </div>
    </Overlay>
  )
}

/** Tick drives (D:\, F:\ …) and open them together as one multi-root brain. */
function DrivePicker() {
  const bridge = ElectronVaultAdapter.bridge()
  const adapter = useAether((s) => s.adapter)
  const drives = useDrives()
  const platform = bridge?.platform ?? ''
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Start from the drives the open vault already mirrors.
  useEffect(() => {
    if (!drives || !(adapter instanceof ElectronVaultAdapter)) return
    setTicked(new Set(drives.filter((d) => adapter.roots.some((r) => samePath(r.path, d, platform)))))
  }, [drives, adapter, platform])

  const chosen = (drives ?? []).filter((d) => ticked.has(d))
  const toggle = (d: string) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })

  const open = async () => {
    if (!chosen.length || busy) return
    setBusy(true)
    setError(null)
    try {
      if (!(await saveOpenNote())) throw new Error(UNSAVED_NOTE)
      const a = await ElectronVaultAdapter.open(chosen)
      if (!a) throw new Error('Electron bridge not available')
      openPanel(null)
      void useAether.getState().openVault(a)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay title="Mirror whole drives" hint="see several drives as one brain" width="w-[560px]" keys={{ v: () => openPanel(null), a: () => openPanel('ai') }}>
      <ErrorLine text={error} />
      <p className="mb-3 text-[12.5px] leading-relaxed text-dim">
        Tick the drives to mirror. Each drive becomes a sun; its folders are planets, folders inside them moons, and your notes orbit them.
      </p>
      {drives === null ? (
        <p className="mb-3 text-[12px] text-faint">Looking for drives…</p>
      ) : drives.length === 0 ? (
        <p className="mb-3 text-[12px] text-faint">No drives found.</p>
      ) : (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {drives.map((d, i) => (
            <label
              key={d}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2 text-[13.5px] font-semibold text-white hover:border-accent/60"
            >
              <input type="checkbox" checked={ticked.has(d)} onChange={() => toggle(d)} data-autofocus={i === 0 ? true : undefined} />
              {d}
              {/^c:/i.test(d) && <span className="text-[11px] font-normal text-faint">Windows</span>}
            </label>
          ))}
        </div>
      )}
      <p className="mb-4 text-[11.5px] leading-relaxed text-faint">
        {MIRROR_NOTE} C:\ holds Windows and your apps; most people leave it out. You can add or remove drives later with <kbd>v</kbd>.
      </p>
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="hud-btn" onClick={() => openPanel(null)}>
          Cancel
        </button>
        <button type="button" className="hud-btn primary" disabled={!chosen.length || busy} onClick={() => void open()}>
          {busy ? 'Opening…' : chosen.length ? `Mirror ${chosen.join(' + ')}` : 'Tick a drive'}
        </button>
      </div>
    </Overlay>
  )
}
