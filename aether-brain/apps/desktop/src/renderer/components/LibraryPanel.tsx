/**
 * The librarian (⇧L): copy every picture of a folder or drive (`D:\`) into one
 * library (`F:\MASTERIMAGES`), sorted Type › Genre › Year with taste tags,
 * and link it into the brain (its index notes make it a star). First it looks
 * through everything and shows the plan; nothing is copied until you say so,
 * and the originals are never touched. The work happens in main
 * (src/main/library-host.ts); this module keeps what the panel shows in a
 * tiny store outside React, so progress keeps arriving while it is closed.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { registerCommands, registerHelpRows, registerKey, useAether } from '@aether/ui'
import type { LibraryEventDto, LibraryModelDto, LibraryPlanDto, LibraryProgressDto, LibraryStatusDto, VaultInfo } from '../../shared/ipc'
import { ElectronVaultAdapter } from '../vault/electron'
import { UNSAVED_NOTE, errorText, flyToPath, openPanel, samePath, saveOpenNote, togglePanel } from '../panels'
import { ErrorLine, Overlay, Section } from './Overlay'

interface LibraryUi {
  status: LibraryStatusDto | null
  progress: LibraryProgressDto | null
  error: string | null
}

let ui: LibraryUi = { status: null, progress: null, error: null }
const subs = new Set<() => void>()
function set(patch: Partial<LibraryUi>): void {
  ui = { ...ui, ...patch }
  for (const cb of subs) cb()
}
function useLibrary(): LibraryUi {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => ui,
  )
}

const bridge = ElectronVaultAdapter.bridge()

/** Run a librarian call; its answer is the new status, a failure shows in the panel. */
async function call(fn: () => Promise<LibraryStatusDto | void>): Promise<void> {
  set({ error: null })
  try {
    const s = await fn()
    if (s) set({ status: s })
  } catch (err) {
    set({ error: errorText(err) })
  }
}

function onEvent(e: LibraryEventDto): void {
  if (e.kind === 'progress') {
    const status = ui.status && e.model ? { ...ui.status, model: e.model } : ui.status
    set({ progress: e.progress, status })
    return
  }
  const before = ui.status?.state
  set({ status: e.status, progress: e.status.progress })
  if (e.status.state === 'analyzing' && before !== 'analyzing') thumbs.clear()
  // A copy that finished while the panel was closed still says so.
  if (before === 'copying' && e.status.state === 'done' && e.status.result && currentPanelClosed()) {
    const r = e.status.result
    useAether.getState().toast(`Librarian: copied ${r.copied.toLocaleString()} picture${r.copied === 1 ? '' : 's'} into ${folderName(e.status.dest)}`, 'success')
  }
}

let panelOpen = false
const currentPanelClosed = () => !panelOpen

export function toggleLibrary(): void {
  togglePanel('library')
}

/* ------------------------------------------------------------------ */
/* Words, numbers, colours                                             */
/* ------------------------------------------------------------------ */

function folderName(abs: string): string {
  return abs.split(/[\\/]+/).filter(Boolean).pop() ?? abs
}

function bytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

const num = (n: number) => n.toLocaleString()
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

const PHASE: Record<LibraryProgressDto['phase'], string> = {
  scanning: 'Walking the folders',
  reading: 'Reading each picture’s header',
  looking: 'Looking at each picture',
  comparing: 'Finding duplicates',
  copying: 'Copying',
  indexing: 'Writing the index notes',
}

/** `about 12 min left`, once the pace is known. */
function timeLeft(p: LibraryProgressDto): string {
  if (p.total === null || p.done < 3 || p.done >= p.total) return ''
  const elapsed = Date.now() - p.since
  if (elapsed < 2000) return ''
  const ms = ((p.total - p.done) * elapsed) / p.done
  const min = Math.round(ms / 60000)
  if (min < 1) return 'under a minute left'
  if (min < 90) return `about ${min} min left`
  return `about ${(min / 60).toFixed(1)} h left`
}

const TYPE_COLOUR: Record<string, string> = {
  Photos: '#4de2ff',
  Screenshots: '#8fa3ff',
  'Concept Art': '#b48cff',
  Renders: '#ff9f5a',
  Sketches: '#e8dcc0',
  'AI Generated': '#ff6bd5',
  Textures: '#9be07a',
  'Memes & Web': '#ffd166',
  Documents: '#a0a8b8',
  Other: '#7a8090',
}

/** What each colour mood looks like, as a swatch. */
const TASTE_SWATCH: Record<string, string> = {
  'dark-moody': 'linear-gradient(135deg,#06070f,#2c1f4d)',
  bright: 'linear-gradient(135deg,#fffaf0,#ffe08a)',
  monochrome: 'linear-gradient(135deg,#1c1c1c,#d8d8d8)',
  muted: 'linear-gradient(135deg,#6f7c80,#b8ae9c)',
  vibrant: 'linear-gradient(135deg,#ff2e7e,#2ee6ff)',
  warm: 'linear-gradient(135deg,#ff7a2e,#ffd36b)',
  cool: 'linear-gradient(135deg,#2e6bff,#2effd9)',
  'high-contrast': 'linear-gradient(135deg,#000 50%,#fff 50%)',
}

/* ------------------------------------------------------------------ */
/* Thumbnails of the plan's pictures                                   */
/* ------------------------------------------------------------------ */

/** Made thumbnails (data URLs; null: none), per plan item id. */
const thumbs = new Map<number, Promise<string | null>>()
let inFlight = 0
const waiting: (() => void)[] = []

/** A plan item's thumbnail, at most four asked of main at once (the brain's own thumbnails share the helper). */
function thumbOf(id: number): Promise<string | null> {
  let p = thumbs.get(id)
  if (!p) {
    p = new Promise<void>((go) => (inFlight < 4 ? go() : waiting.push(go)))
      .then(() => {
        inFlight++
        return bridge ? bridge.libraryThumb(id) : null
      })
      .catch(() => null)
      .finally(() => {
        inFlight--
        waiting.shift()?.()
      })
    thumbs.set(id, p)
  }
  return p
}

function Thumb({ id, colour }: { id: number; colour: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void thumbOf(id).then((s) => alive && setSrc(s))
    return () => {
      alive = false
    }
  }, [id])
  return (
    <span
      className="block h-14 w-14 shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/40"
      style={src === undefined ? { boxShadow: `inset 0 0 18px ${colour}22` } : undefined}
      aria-hidden
    >
      {src && <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

function Bar({ done, total }: { done: number; total: number | null }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div
        className={`h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-150 ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  )
}

function PathRow({ label, which, value, disabled }: { label: string; which: 'source' | 'dest'; value: string; disabled: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const apply = () => {
    if (!bridge || draft.trim() === value) return
    void call(() => bridge.libraryConfigure({ [which]: draft.trim() }))
  }
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="w-12 shrink-0 text-[12px] text-dim">{label}</span>
      <input
        className="input flex-1 !py-1.5 font-mono !text-[12.5px]"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        aria-label={which === 'source' ? 'Folder to sort' : 'Library folder'}
      />
      <button type="button" className="hud-btn" disabled={disabled} onClick={() => bridge && void call(() => bridge.libraryPick(which))}>
        Choose…
      </button>
    </div>
  )
}

function ModelSection({ model, busy }: { model: LibraryModelDto; busy: boolean }) {
  const act = (a: 'download' | 'cancel' | 'remove') => bridge && void call(() => bridge.libraryModel(a))
  return (
    <Section title="Vision model" aside={model.label}>
      {model.error && <ErrorLine text={model.error} />}
      {model.ready ? (
        <div className="flex items-center gap-3 text-[12.5px] text-dim">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#7dffb0]" style={{ boxShadow: '0 0 10px #7dffb0' }} aria-hidden />
          <span className="flex-1">Ready · {bytes(model.bytes)} · runs on this computer only, nothing is sent anywhere</span>
          <button type="button" className="hud-btn" disabled={busy} onClick={() => act('remove')}>
            Delete
          </button>
        </div>
      ) : model.downloading ? (
        <div className="text-[12.5px] text-dim">
          <div className="flex items-center gap-3">
            <span className="flex-1">
              Downloading… {bytes(model.done)}
              {model.total ? ` of ${bytes(model.total)}` : ''}
            </span>
            <button type="button" className="hud-btn" onClick={() => act('cancel')}>
              Stop
            </button>
          </div>
          <Bar done={model.done} total={model.total} />
        </div>
      ) : (
        <div className="text-[12.5px] text-dim">
          <p className="mb-2">
            With it, the librarian sees what each picture shows (concept art or a photo, sci-fi or fantasy, characters or landscapes). Without it, it sorts by each file’s own
            data, names and folders, and colours.
          </p>
          <button type="button" className="hud-btn" disabled={busy} onClick={() => act('download')}>
            Download (about {model.mb} MB, once)
          </button>
          <span className="ml-2 text-[11.5px] text-faint">from Hugging Face; after that it works offline</span>
        </div>
      )}
    </Section>
  )
}

function PlanView({ plan }: { plan: LibraryPlanDto }) {
  const maxYear = Math.max(1, ...plan.years.map((y) => y.count))
  const chips: [string, string][] = [
    [plural(plan.toCopy, 'new picture'), 'to copy'],
    [bytes(plan.bytes), plan.freeBytes === null ? '' : `of ${bytes(plan.freeBytes)} free`],
  ]
  if (plan.already) chips.push([num(plan.already), 'already in the library'])
  if (plan.duplicates) chips.push([num(plan.duplicates), plan.duplicates === 1 ? 'duplicate skipped (same bytes)' : 'duplicates skipped (same bytes)'])
  if (plan.removed) chips.push([num(plan.removed), 'you deleted from it: left out'])
  if (plan.tiny) chips.push([num(plan.tiny), 'icons and tiny pictures left out'])
  if (plan.installs) chips.push([num(plan.installs), plan.installs === 1 ? 'game or program folder skipped' : 'game and program folders skipped'])
  if (plan.unreadable) chips.push([num(plan.unreadable), 'not really pictures'])
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2" aria-label="Plan summary">
        {chips.map(([a, b]) => (
          <span key={`${a}${b}`} className="rounded-full border border-[var(--line)] bg-black/25 px-3 py-1 text-[12px]">
            <span className="font-semibold text-white">{a}</span> <span className="text-dim">{b}</span>
          </span>
        ))}
      </div>
      {!plan.vision.model && (
        <p className="mb-3 text-[12px] text-faint">
          {plan.vision.error ?? (plan.vision.colours ? 'Sorted by file data, names, folders and colours (no vision model yet).' : 'Sorted by file data, names and folders.')}
        </p>
      )}
      {plan.truncated && <p className="mb-3 text-[12px] text-danger">The drive has more folders than the librarian walks in one go; run it again on a subfolder for the rest.</p>}

      <Section title="Where everything goes" aside={`${folderName(plan.dest)} › type › genre › year`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {plan.types.map((t) => {
            const colour = TYPE_COLOUR[t.type] ?? '#8f7cff'
            return (
              <div key={t.type} className="rounded-xl border border-[var(--line)] bg-black/25 p-3" style={{ boxShadow: `inset 3px 0 0 ${colour}` }} aria-label={`${t.type}: ${t.count} pictures`}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-[14px] font-semibold" style={{ color: colour }}>
                    {t.type}
                  </span>
                  <span className="text-[12px] text-dim">
                    {plural(t.count, 'picture')} · {bytes(t.bytes)}
                  </span>
                </div>
                <ul className="flex flex-col gap-2">
                  {t.genres.map((g) => (
                    <li key={g.genre ?? '-'}>
                      <div className="mb-1 flex items-baseline gap-2 text-[12.5px]">
                        <span className="text-white">{g.genre ?? 'by year'}</span>
                        <span className="text-faint">{num(g.count)}</span>
                        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-faint">{g.years.map((y) => `${y.year} ${y.count}`).join(' · ')}</span>
                      </div>
                      <div className="flex gap-1.5 overflow-hidden">
                        {g.samples.map((id) => (
                          <Thumb key={id} id={id} colour={colour} />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </Section>

      {plan.taste.length > 0 && (
        <Section title="Taste" aside="colour moods; each gets a note gathering its pictures">
          <div className="flex flex-wrap gap-2">
            {plan.taste.map((t) => (
              <span key={t.tag} className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-black/25 py-1 pl-1 pr-3 text-[12px]">
                <span className="h-5 w-5 rounded-full border border-white/20" style={{ background: TASTE_SWATCH[t.tag] ?? '#555' }} aria-hidden />
                <span className="text-white">{t.label}</span>
                <span className="text-faint">{num(t.count)}</span>
              </span>
            ))}
          </div>
        </Section>
      )}

      {plan.years.length > 0 && (
        <Section title="Years">
          <div className="flex items-end gap-1" style={{ height: 64 }} aria-label="Pictures per year">
            {[...plan.years].reverse().map((y) => (
              <div key={y.year} className="flex min-w-0 flex-1 flex-col items-center justify-end" title={`${y.year}: ${num(y.count)}`} style={{ height: '100%' }}>
                <div className="w-full rounded-t bg-gradient-to-t from-accent to-accent2" style={{ height: `${Math.max(4, Math.round((y.count / maxYear) * 46))}px`, opacity: 0.85 }} />
                <span className="mt-1 truncate text-[10px] text-faint">{y.year === 'Undated' ? '?' : y.year.slice(2)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

/** Load the vault main just reopened into the app (as the vault folders panel does). */
function load(info: VaultInfo): void {
  void useAether.getState().openVault(ElectronVaultAdapter.fromInfo(info))
}

export function LibraryPanel() {
  const { status, progress, error } = useLibrary()
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    panelOpen = true
    if (bridge) void call(() => bridge.libraryStatus())
    return () => {
      panelOpen = false
    }
  }, [])

  const s = status
  const busy = s?.state === 'analyzing' || s?.state === 'copying'
  const from = s ? s.source : ''
  const to = s ? s.dest : ''

  /** Add the library folder to the brain, then fly to its hub once it is read. */
  const addToBrain = async () => {
    if (!bridge || !s || adding) return
    setAdding(true)
    set({ error: null })
    try {
      if (!(await saveOpenNote())) throw new Error(UNSAVED_NOTE)
      const info = await bridge.addRootPath(s.dest)
      load(info)
      const root = info.roots.find((r) => samePath(r.path, s.dest, bridge.platform))
      const hub = `${folderName(s.dest)}.md`
      openPanel(null)
      if (root) flyToPath(info.roots.length > 1 ? `${root.mount}/${hub}` : hub)
    } catch (err) {
      set({ error: errorText(err) })
    } finally {
      setAdding(false)
    }
  }

  return (
    <Overlay
      title="Librarian"
      hint="copies every picture into one sorted library the brain links; the originals stay where they are"
      width="w-[960px]"
      keys={{ L: () => openPanel(null) }}
    >
      <ErrorLine text={error ?? s?.error} />
      {!s ? (
        <p className="text-[12.5px] text-dim">Asking the librarian…</p>
      ) : (
        <>
          <Section title="From → to" aside="copies only: nothing in the source is moved, renamed or changed">
            <PathRow label="From" which="source" value={from} disabled={busy} />
            <PathRow label="To" which="dest" value={to} disabled={busy} />
            <label className="mt-1 flex items-center gap-2 text-[12px] text-dim">
              <input type="checkbox" checked={s.includeTiny} disabled={busy} onChange={(e) => bridge && void call(() => bridge.libraryConfigure({ includeTiny: e.target.checked }))} />
              Keep icons and tiny pictures too (under 160 px or 4 KB)
            </label>
          </Section>

          <ModelSection model={s.model} busy={busy} />

          {busy && progress && (
            <Section title={s.state === 'analyzing' ? 'Looking through' : 'Copying'}>
              <div className="flex items-center gap-3 text-[12.5px] text-dim" aria-live="polite">
                <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent" aria-hidden />
                <span className="flex-1">
                  {PHASE[progress.phase]}… {num(progress.done)}
                  {progress.total !== null ? ` / ${num(progress.total)}` : progress.phase === 'scanning' ? ' folders' : ''}
                  <span className="ml-2 text-faint">{timeLeft(progress)}</span>
                </span>
                <button type="button" className="hud-btn" onClick={() => bridge && void call(() => bridge.libraryStop())}>
                  Stop
                </button>
              </div>
              <Bar done={progress.done} total={progress.total} />
            </Section>
          )}
          {busy && !progress && <p className="mb-4 text-[12.5px] text-dim">Starting…</p>}

          {s.state === 'idle' && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="hud-btn primary" data-autofocus onClick={() => bridge && void call(() => bridge.libraryAnalyze())}>
                Look through {from}
              </button>
              <span className="text-[12px] text-faint">Nothing is copied yet: you see the plan first.</span>
            </div>
          )}

          {(s.state === 'planned' || (s.state === 'copying' && s.plan)) && s.plan && (
            <>
              <PlanView plan={s.plan} />
              {s.state === 'planned' && (
                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-4">
                  <button
                    type="button"
                    className="hud-btn primary"
                    data-autofocus
                    disabled={s.plan.toCopy === 0 && s.plan.already === 0}
                    onClick={() => bridge && void call(() => bridge.libraryCopy())}
                  >
                    {s.plan.toCopy ? `Copy ${plural(s.plan.toCopy, 'picture')} (${bytes(s.plan.bytes)}) to ${to}` : `Update the index notes in ${to}`}
                  </button>
                  <button type="button" className="hud-btn" onClick={() => bridge && void call(() => bridge.libraryAnalyze())}>
                    Look again
                  </button>
                </div>
              )}
            </>
          )}

          {s.state === 'done' && s.result && (
            <Section title={s.result.stopped ? 'Stopped' : 'Done'}>
              <p className="mb-3 text-[13px] text-white" aria-live="polite">
                Copied {plural(s.result.copied, 'picture')} ({bytes(s.result.bytes)}) into {to}
                {s.result.alreadyThere ? `, ${num(s.result.alreadyThere)} were there already` : ''}, and wrote {plural(s.result.notes, 'index note')}.
                {s.result.stopped ? ' The rest are copied the next time you run it.' : ''}
              </p>
              {s.result.failed.length > 0 && (
                <details className="mb-3 text-[12px] text-danger">
                  <summary>{plural(s.result.failed.length, 'picture')} could not be copied</summary>
                  <ul className="mt-1 max-h-40 overflow-auto font-mono text-[11.5px]">
                    {s.result.failed.map((f) => (
                      <li key={f.rel}>
                        {f.rel}
                        {f.error ? `: ${f.error}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {s.result.inVault && s.result.hubPath ? (
                  <button
                    type="button"
                    className="hud-btn primary"
                    data-autofocus
                    onClick={() => {
                      openPanel(null)
                      flyToPath(s.result!.hubPath!)
                    }}
                  >
                    Fly to {folderName(to)}
                  </button>
                ) : (
                  <button type="button" className="hud-btn primary" data-autofocus disabled={adding} onClick={() => void addToBrain()}>
                    Show {folderName(to)} in the brain
                  </button>
                )}
                <button type="button" className="hud-btn" onClick={() => bridge && void call(() => bridge.libraryAnalyze())}>
                  Look through again
                </button>
              </div>
              <p className="mt-3 text-[11.5px] text-faint">In the brain, {folderName(to)} is a star: its types are planets, and ⇧G on it opens every picture around it.</p>
            </Section>
          )}
        </>
      )}
    </Overlay>
  )
}

/** ⇧L, the palette and the cheatsheet; progress events kept even while the panel is closed. */
export function registerLibrary(): void {
  if (!bridge) return
  bridge.onLibraryEvent(onEvent)
  registerKey('L', () => toggleLibrary())
  registerCommands([
    { id: 'librarian', title: 'Librarian: copy and sort every picture of a drive into one library…', keys: 'Shift+L', group: 'vault', run: () => openPanel('library') },
  ])
  registerHelpRows('Desktop', [['⇧L', 'Librarian: copy every picture of a drive into a sorted library the brain links']])
}
